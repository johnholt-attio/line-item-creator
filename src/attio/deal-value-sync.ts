import {kv} from "attio/server"
import {z} from "zod"
import type {DataModel} from "../utils/line-item-schema"
import {DEAL_ATTRIBUTES, LINE_ITEM_ATTRIBUTES} from "../utils/line-item-schema"
import {
    createComment,
    getAttribute,
    getRecord,
    getWorkspaceMember,
    putRecordValues,
    queryRecords,
} from "./rest"

/**
 * Keeps Deal value equal to the sum of its line items' Line total, for deals that have at least
 * one line item. Deals without line items are left alone, so reps can enter their own value.
 */

export const KV_KEYS = {
    webhook: "deal-value-sync:webhook",
    /** The admin who registered the webhook: fallback comment author. */
    setupAdmin: "deal-value-sync:setup-admin",
    /** Which deal a line item belongs to, so a deletion can be traced back to its deal. */
    lineItemDeal: (lineItemId: string) => `deal-value-sync:line-item-deal:${lineItemId}`,
    /** Set while the app controls a deal's value. Cleared once the deal has no line items. */
    managedDeal: (dealId: string) => `deal-value-sync:managed-deal:${dealId}`,
    delivery: (idempotencyKey: string) => `deal-value-sync:delivery:${idempotencyKey}`,
}

const WebhookConfigSchema = z.object({
    handlerId: z.string(),
    webhookId: z.string(),
    secret: z.string(),
    lineItemsObjectId: z.string(),
    dealsObjectId: z.string(),
    dealValueAttributeId: z.string(),
})

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>

export async function getWebhookConfig(): Promise<WebhookConfig | null> {
    const stored = await kv.get(KV_KEYS.webhook)
    const parsed = WebhookConfigSchema.safeParse(stored?.value)
    return parsed.success ? parsed.data : null
}

export async function saveWebhookConfig(config: WebhookConfig): Promise<void> {
    await kv.set(KV_KEYS.webhook, {...config})
}

export interface Actor {
    type: string | null
    id: string | null
}

const NumericValuesSchema = z.array(
    z.object({
        value: z.union([z.number(), z.string()]).nullable().optional(),
        currency_value: z.union([z.number(), z.string()]).nullable().optional(),
        currency_code: z.string().nullable().optional(),
    })
)

/** Reads the first number or currency value of an attribute, or `null` if it's empty. */
function readNumber(values: Array<unknown> | undefined): number | null {
    const parsed = NumericValuesSchema.safeParse(values ?? [])
    const first = parsed.success ? parsed.data[0] : undefined
    const raw = first?.currency_value ?? first?.value
    if (raw === null || raw === undefined || raw === "") {
        return null
    }
    const number = Number(raw)
    return Number.isFinite(number) ? number : null
}

const DealIdSchema = z.array(z.object({target_record_id: z.string()}))

/** The deal a line item record points at, or `null` if it isn't linked to one. */
export function readDealId(values: Record<string, Array<unknown>>): string | null {
    const parsed = DealIdSchema.safeParse(values[LINE_ITEM_ATTRIBUTES.deal] ?? [])
    return parsed.success ? (parsed.data[0]?.target_record_id ?? null) : null
}

function round(value: number): number {
    // Currency values are stored with up to 4 decimal places.
    return Math.round(value * 10000) / 10000
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Line totals for a deal's line items, or `null` if any of them hasn't been calculated yet. */
async function loadLineTotals({
    model,
    dealId,
}: {
    model: DataModel
    dealId: string
}): Promise<Array<number> | null> {
    const lineItems = await queryRecords({
        objectSlug: model.slugs.lineItems,
        filter: {
            [LINE_ITEM_ATTRIBUTES.deal]: {
                target_object: model.slugs.deals,
                target_record_id: dealId,
            },
        },
    })
    const totals = lineItems.map((lineItem) =>
        readNumber(lineItem.values[LINE_ITEM_ATTRIBUTES.lineTotal])
    )
    return totals.some((total) => total === null) ? null : (totals as Array<number>)
}

export type RecalculationTrigger = "line-item-changed" | "deal-value-edited"

/**
 * Recalculates one deal's value. Safe to call repeatedly: it does nothing when the value is
 * already correct, which also stops the app reacting to its own writes.
 */
export async function recalculateDealValue({
    model,
    dealId,
    trigger,
    actor,
}: {
    model: DataModel
    dealId: string
    trigger: RecalculationTrigger
    actor: Actor
}): Promise<void> {
    const deal = await getRecord({objectSlug: model.slugs.deals, recordId: dealId})
    if (!deal) {
        return // The deal was deleted.
    }
    const currentValue = readNumber(deal.values[DEAL_ATTRIBUTES.value])
    const ownerId = readOwnerId(deal.values[DEAL_ATTRIBUTES.owner])

    let lineTotals = await loadLineTotals({model, dealId})
    if (lineTotals === null) {
        // A new line item's formula may not have been calculated yet. Try once more.
        await sleep(1500)
        lineTotals = await loadLineTotals({model, dealId})
    }
    if (lineTotals === null) {
        console.error(
            "[Deal value sync] A line item has no Line total, so Deal value wasn't updated"
        )
        return
    }

    if (lineTotals.length === 0) {
        // Only clear values the app set. A deal that never had line items keeps the rep's value.
        const managed = await kv.get(KV_KEYS.managedDeal(dealId))
        if (!managed) {
            return
        }
        await kv.delete(KV_KEYS.managedDeal(dealId))
        if (currentValue === null) {
            return
        }
        await putRecordValues({
            objectSlug: model.slugs.deals,
            recordId: dealId,
            values: {[DEAL_ATTRIBUTES.value]: []},
        })
        await postComment({
            model,
            dealId,
            ownerId,
            actor,
            message:
                "Deal value was cleared because this deal no longer has any line items. Add a line item, or enter a value by hand.",
        })
        return
    }

    const total = round(lineTotals.reduce((sum, lineTotal) => sum + lineTotal, 0))
    await kv.set(KV_KEYS.managedDeal(dealId), true)
    if (currentValue !== null && round(currentValue) === total) {
        return
    }

    await putRecordValues({
        objectSlug: model.slugs.deals,
        recordId: dealId,
        values: {[DEAL_ATTRIBUTES.value]: total},
    })

    if (trigger === "deal-value-edited") {
        const formatted = await formatDealValue({model, amount: total})
        await postComment({
            model,
            dealId,
            ownerId,
            actor,
            message: `Deal value was reset to ${formatted} because this deal's value is calculated from its line items. To change it, edit the line items.`,
        })
    }
}

async function formatDealValue({
    model,
    amount,
}: {
    model: DataModel
    amount: number
}): Promise<string> {
    try {
        const attribute = await getAttribute({
            objectSlug: model.slugs.deals,
            attributeSlug: DEAL_ATTRIBUTES.value,
        })
        const currency = attribute?.config.currency?.default_currency_code
        if (currency) {
            return new Intl.NumberFormat("en-US", {style: "currency", currency}).format(amount)
        }
    } catch (error) {
        console.error("[Deal value sync] Couldn't read the Deal value currency", error)
    }
    return String(amount)
}

const OwnerValuesSchema = z.array(
    z.object({
        referenced_actor_type: z.string(),
        referenced_actor_id: z.string().nullable(),
    })
)

/** The deal owner's workspace member ID, or `null` if the deal has no owner. */
function readOwnerId(values: Array<unknown> | undefined): string | null {
    const parsed = OwnerValuesSchema.safeParse(values ?? [])
    const owner = parsed.success ? parsed.data[0] : undefined
    return owner?.referenced_actor_type === "workspace-member"
        ? (owner.referenced_actor_id ?? null)
        : null
}

/**
 * Comments must be authored by a workspace member, and Attio doesn't notify people about their
 * own comments. So the author is the first of these who isn't the person who made the change:
 * the member chosen in settings, the admin who last ran setup, then the deal owner. The person
 * who made the change is mentioned by email, which notifies them.
 *
 * If everyone available is the person who made the change, the comment is posted without a
 * mention and they aren't notified. Failures are logged but don't undo the value change.
 */
async function postComment({
    model,
    dealId,
    ownerId,
    actor,
    message,
}: {
    model: DataModel
    dealId: string
    ownerId: string | null
    actor: Actor
    message: string
}): Promise<void> {
    try {
        const setupAdmin = await kv.get(KV_KEYS.setupAdmin)
        const candidates = [
            model.dealValue.commentAuthorId,
            typeof setupAdmin?.value === "string" ? setupAdmin.value : null,
            ownerId,
        ].filter((id): id is string => id !== null)
        const changedBy = actor.type === "workspace-member" && actor.id ? actor.id : null
        const authorId = candidates.find((id) => id !== changedBy) ?? candidates[0]
        if (!authorId) {
            console.error("[Deal value sync] No one is available to post the comment as")
            return
        }

        let mention = ""
        if (changedBy && changedBy !== authorId) {
            const member = await getWorkspaceMember(changedBy)
            if (member) {
                mention = `${member.emailAddress} `
            }
        } else if (changedBy) {
            console.error(
                "[Deal value sync] The only available comment author made the change, so they won't be notified"
            )
        }

        await createComment({
            objectSlug: model.slugs.deals,
            recordId: dealId,
            authorId,
            content: `${mention}${message}`,
        })
    } catch (error) {
        console.error("[Deal value sync] Failed to post a comment", error)
    }
}
