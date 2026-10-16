import {hmac} from "@noble/hashes/hmac.js"
import {sha256} from "@noble/hashes/sha2.js"
import {bytesToHex, utf8ToBytes} from "@noble/hashes/utils.js"
import {kv} from "attio/server"
import {z} from "zod"
import type {Actor, WebhookConfig} from "../../attio/deal-value-sync"
import {
    getWebhookConfig,
    KV_KEYS,
    readDealId,
    recalculateDealValue,
} from "../../attio/deal-value-sync"
import {getRecord} from "../../attio/rest"
import type {DataModel} from "../../utils/line-item-schema"
import {loadDataModel} from "../extensions/add-line-item/data-model"

/**
 * Receives Attio webhooks for line items being created, updated or deleted, and for Deal value
 * being edited, and keeps Deal value equal to the sum of the deal's line items.
 *
 * Registered by "Set up automatically" when "Calculate deal value from line items" is on.
 * Attio delivers at least once, retries failures and expects a reply within 5 seconds, so every
 * step is safe to repeat.
 */

const EventSchema = z.object({
    event_type: z.string(),
    id: z.object({
        object_id: z.string(),
        record_id: z.string(),
        attribute_id: z.string().optional(),
    }),
    actor: z
        .object({type: z.string().nullable().optional(), id: z.string().nullable().optional()})
        .optional(),
})

const PayloadSchema = z.object({events: z.array(EventSchema)})

type WebhookEvent = z.infer<typeof EventSchema>

const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 4 // Attio retries for about 3 days.

export default async function lineItemsSync(request: Request): Promise<Response> {
    try {
        const body = await request.text()
        const config = await getWebhookConfig()
        if (!config || !isSignatureValid({body, request, secret: config.secret})) {
            return new Response("Invalid signature", {status: 401})
        }

        const idempotencyKey = request.headers.get("Idempotency-Key")
        if (idempotencyKey && (await kv.get(KV_KEYS.delivery(idempotencyKey)))) {
            return new Response("Already processed", {status: 200})
        }

        let json: unknown
        try {
            json = JSON.parse(body)
        } catch (_error) {
            return new Response("Invalid JSON", {status: 400})
        }
        const payload = PayloadSchema.safeParse(json)
        if (!payload.success) {
            console.error("[Deal value sync] Unexpected webhook payload", payload.error)
            return new Response("Unexpected payload", {status: 400})
        }

        const model = await loadDataModel()
        if (model.dealValue.sync) {
            for (const event of payload.data.events) {
                await handleEvent({event, config, model})
            }
        }

        if (idempotencyKey) {
            await kv.set(KV_KEYS.delivery(idempotencyKey), true, {
                ttlInSeconds: DELIVERY_TTL_SECONDS,
            })
        }
        return new Response("OK", {status: 200})
    } catch (error) {
        // A non-2xx reply makes Attio retry later.
        console.error("[Deal value sync] Failed to handle webhook", error)
        return new Response("Error", {status: 500})
    }
}

/** Attio signs the raw body with HMAC-SHA256 and sends it hex-encoded in `Attio-Signature`. */
function isSignatureValid({
    body,
    request,
    secret,
}: {
    body: string
    request: Request
    secret: string
}): boolean {
    const signature = request.headers.get("Attio-Signature") ?? ""
    const expected = bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(body)))
    if (signature.length !== expected.length) {
        return false
    }
    // Compare every character so the time taken doesn't reveal how much matched.
    let difference = 0
    for (let i = 0; i < expected.length; i++) {
        difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i)
    }
    return difference === 0
}

async function handleEvent({
    event,
    config,
    model,
}: {
    event: WebhookEvent
    config: WebhookConfig
    model: DataModel
}): Promise<void> {
    const actor: Actor = {type: event.actor?.type ?? null, id: event.actor?.id ?? null}
    const recordId = event.id.record_id

    if (event.id.object_id === config.dealsObjectId) {
        if (
            event.event_type === "record.updated" &&
            event.id.attribute_id === config.dealValueAttributeId
        ) {
            await recalculateDealValue({
                model,
                dealId: recordId,
                trigger: "deal-value-edited",
                actor,
            })
        }
        return
    }

    if (event.id.object_id !== config.lineItemsObjectId) {
        return
    }

    const previous = await kv.get(KV_KEYS.lineItemDeal(recordId))
    const previousDealId = typeof previous?.value === "string" ? previous.value : null

    if (event.event_type === "record.deleted") {
        await kv.delete(KV_KEYS.lineItemDeal(recordId))
        if (previousDealId) {
            await recalculateDealValue({
                model,
                dealId: previousDealId,
                trigger: "line-item-changed",
                actor,
            })
        } else {
            console.error("[Deal value sync] A deleted line item's deal is unknown")
        }
        return
    }

    if (event.event_type !== "record.created" && event.event_type !== "record.updated") {
        return
    }

    const lineItem = await getRecord({objectSlug: model.slugs.lineItems, recordId})
    const dealId = lineItem ? readDealId(lineItem.values) : null

    if (dealId) {
        await kv.set(KV_KEYS.lineItemDeal(recordId), dealId)
    } else {
        await kv.delete(KV_KEYS.lineItemDeal(recordId))
    }

    // A line item moved to another deal, or unlinked, changes the old deal's total too.
    if (previousDealId && previousDealId !== dealId) {
        await recalculateDealValue({
            model,
            dealId: previousDealId,
            trigger: "line-item-changed",
            actor,
        })
    }
    if (dealId) {
        await recalculateDealValue({model, dealId, trigger: "line-item-changed", actor})
    }
}
