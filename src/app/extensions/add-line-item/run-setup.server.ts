import {
    createWebhookHandler,
    getCurrentUser,
    getWebhookHandler,
    kv,
    Settings,
    updateWebhookHandler,
} from "attio/server"
import {
    getWebhookConfig,
    KV_KEYS,
    readDealId,
    saveWebhookConfig,
} from "../../../attio/deal-value-sync"
import {describeApiError} from "../../../attio/errors"
import type {AttioAttribute, NewAttribute} from "../../../attio/rest"
import {
    createAttribute,
    createObject,
    createWebhook,
    deleteWebhook,
    queryRecords,
    updateAttribute,
} from "../../../attio/rest"
import type {AttributeRequirement, DataModel, ObjectKey} from "../../../utils/line-item-schema"
import {DEAL_ATTRIBUTES, LINE_ITEM_ATTRIBUTES, OBJECT_TITLES} from "../../../utils/line-item-schema"
import settingsSchema from "../../settings/schema"
import {checkCurrentUserIsAdmin} from "./admin-check"
import {loadDataModel} from "./data-model"
import type {SetupAnalysis} from "./setup-analysis"
import {analyzeSetup} from "./setup-analysis"

export type RunSetupResult =
    {ok: true; changes: Array<string>} | {ok: false; message: string; changes: Array<string>}

const OBJECT_NOUNS: Partial<Record<ObjectKey, {singular: string; plural: string}>> = {
    products: {singular: "Product", plural: "Products"},
    lineItems: {singular: "Line item", plural: "Line items"},
}

const FALLBACK_CURRENCY = "USD"

/** A problem the admin has to resolve by hand before setup can continue. */
class SetupBlockedError extends Error {}

/**
 * Makes every automatic fix the setup check found. Admins only. In order: points the app's
 * settings at the Products attributes that hold the data, creates missing objects, replaces or
 * restores attributes, creates missing ones, and registers the Deal value webhook.
 *
 * It never deletes data. A wrongly configured attribute is renamed and archived, keeping its
 * data, and replaced with a correct one. The only thing deleted is a webhook that stopped
 * working, which is replaced straight away. Formula attributes can't be created; those stay as
 * manual steps in the setup guide.
 */
export default async function runSetup(): Promise<RunSetupResult> {
    const admin = await checkCurrentUserIsAdmin()
    if (!admin.isAdmin) {
        return {ok: false, message: admin.reason, changes: []}
    }

    const changes: Array<string> = []
    try {
        let model = await loadDataModel()
        let analysis = await analyzeSetup(model)

        // Settings first: pointing the app at the Products attributes that hold the data changes
        // what everything else checks.
        let changedSettings = false
        for (const issue of analysis.issues) {
            const fix = issue.autoFix
            if (fix?.kind !== "use-product-attribute") {
                continue
            }
            await Settings.setSettings(
                settingsSchema,
                fix.setting === "name" ? "product_name_attribute" : "product_price_attribute",
                fix.slug
            )
            changes.push(`Set the product ${fix.setting} to "${fix.title}" in the app's settings`)
            changedSettings = true
        }
        if (changedSettings) {
            model = await loadDataModel()
            analysis = await analyzeSetup(model)
        }

        // Objects first: their attributes can only be checked and created once they exist.
        let createdObject = false
        for (const issue of analysis.issues) {
            if (issue.autoFix?.kind !== "create-object") {
                continue
            }
            const key = issue.autoFix.object
            const nouns = OBJECT_NOUNS[key]
            if (!nouns) {
                continue
            }
            await createObject({
                apiSlug: model.slugs[key],
                singularNoun: nouns.singular,
                pluralNoun: nouns.plural,
            })
            changes.push(`Created the ${OBJECT_TITLES[key]} object`)
            createdObject = true
        }
        if (createdObject) {
            analysis = await analyzeSetup(model)
        }

        const currency = pickCurrency({attributesByObject: analysis.attributesByObject, model})
        // Slugs moved out of the way by a replacement, as "object_slug.attribute_slug".
        const freedSlugs = new Set<string>()

        const createCorrectAttribute = async (requirement: AttributeRequirement) => {
            if (requirement.inverse && requirement.targetObject) {
                const targetSlug = model.slugs[requirement.targetObject]
                const taken = analysis.attributesByObject
                    .get(requirement.targetObject)
                    ?.has(requirement.inverse.slug)
                if (taken && !freedSlugs.has(`${targetSlug}.${requirement.inverse.slug}`)) {
                    throw new SetupBlockedError(
                        `${OBJECT_TITLES[requirement.targetObject]} already has an attribute with the API slug \`${requirement.inverse.slug}\`, so the ${requirement.title} relationship can't be created. Rename that attribute's API slug, then try again.`
                    )
                }
            }
            await createAttribute({
                objectSlug: model.slugs[requirement.object],
                attribute: buildAttribute({requirement, currency, model}),
            })
            changes.push(`Added "${requirement.title}" to ${OBJECT_TITLES[requirement.object]}`)
        }

        // Replacements first, so the old relationship's slugs are free before anything is created.
        for (const issue of analysis.issues) {
            const fix = issue.autoFix
            if (fix?.kind !== "replace-attribute") {
                continue
            }
            const objectSlug = model.slugs[fix.requirement.object]
            await updateAttribute({
                objectSlug,
                attributeSlug: fix.requirement.slug,
                changes: {api_slug: fix.oldSlug, is_archived: true},
            })
            changes.push(`Renamed "${fix.currentTitle}" to \`${fix.oldSlug}\` and archived it`)
            if (fix.oldInverse) {
                await updateAttribute({
                    objectSlug: fix.oldInverse.objectSlug,
                    attributeSlug: fix.oldInverse.slug,
                    changes: {api_slug: fix.oldInverse.oldSlug, is_archived: true},
                })
                freedSlugs.add(`${fix.oldInverse.objectSlug}.${fix.oldInverse.slug}`)
                changes.push(
                    `Renamed \`${fix.oldInverse.slug}\` to \`${fix.oldInverse.oldSlug}\` and archived it`
                )
            }
            await createCorrectAttribute(fix.requirement)
        }

        for (const issue of analysis.issues) {
            const fix = issue.autoFix
            if (fix?.kind === "restore-attribute") {
                await updateAttribute({
                    objectSlug: model.slugs[fix.object],
                    attributeSlug: fix.slug,
                    changes: {is_archived: false},
                })
                changes.push(`Restored \`${fix.slug}\` on ${OBJECT_TITLES[fix.object]}`)
            } else if (fix?.kind === "create-attribute") {
                await createCorrectAttribute(fix.requirement)
            }
        }

        if (analysis.issues.some((issue) => issue.autoFix?.kind === "register-webhook")) {
            await registerWebhook(analysis)
            changes.push("Registered the Deal value webhook")
            const recorded = await recordExistingLineItems(model)
            changes.push(`Recorded the deal for ${recorded} existing line item(s)`)
        }

        return {ok: true, changes}
    } catch (error) {
        if (error instanceof SetupBlockedError) {
            return {ok: false, message: error.message, changes}
        }
        console.error("[Run setup] Automatic setup failed", error)
        const done =
            changes.length > 0 ? ` ${changes.length} change(s) were made before it stopped.` : ""
        return {ok: false, message: `${describeApiError(error)}${done}`, changes}
    }
}

const WEBHOOK_FILE_NAME = "line-items-sync"

/**
 * Registers (or replaces) the Attio webhook behind "Calculate deal value from line items", and
 * remembers its signing secret. The admin running setup becomes the fallback comment author.
 */
async function registerWebhook(analysis: SetupAnalysis): Promise<void> {
    const lineItemsObjectId = analysis.objectIds.get("lineItems")
    const dealsObjectId = analysis.objectIds.get("deals")
    const dealValueAttributeId = analysis.attributesByObject
        .get("deals")
        ?.get(DEAL_ATTRIBUTES.value)?.id.attribute_id
    if (!lineItemsObjectId || !dealsObjectId || !dealValueAttributeId) {
        throw new SetupBlockedError(
            "The webhook needs the Line items and Deals objects and the Deal value attribute. Fix those first, then try again."
        )
    }

    // Replace a webhook that stopped working. Reuse its handler so the URL stays the same.
    const existing = await getWebhookConfig()
    if (existing) {
        await deleteWebhook(existing.webhookId)
    }
    let handler = null
    if (existing) {
        try {
            handler = await getWebhookHandler(existing.handlerId)
        } catch (_error) {
            handler = null
        }
    }
    if (!handler) {
        handler = await createWebhookHandler({fileName: WEBHOOK_FILE_NAME})
    }

    const isObject = (objectId: string) => ({
        field: "id.object_id",
        operator: "equals",
        value: objectId,
    })
    const lineItemsFilter = {$and: [isObject(lineItemsObjectId)]}
    const {webhookId, secret} = await createWebhook({
        targetUrl: handler.url,
        subscriptions: [
            {event_type: "record.created", filter: lineItemsFilter},
            {event_type: "record.updated", filter: lineItemsFilter},
            {event_type: "record.deleted", filter: lineItemsFilter},
            {
                event_type: "record.updated",
                filter: {
                    $and: [
                        isObject(dealsObjectId),
                        {field: "id.attribute_id", operator: "equals", value: dealValueAttributeId},
                    ],
                },
            },
        ],
    })
    await updateWebhookHandler(handler.id, {externalWebhookId: webhookId})
    await saveWebhookConfig({
        handlerId: handler.id,
        webhookId,
        secret,
        lineItemsObjectId,
        dealsObjectId,
        dealValueAttributeId,
    })

    const user = getCurrentUser()
    if (user) {
        await kv.set(KV_KEYS.setupAdmin, user.id)
    }
}

/**
 * Remembers which deal each existing line item belongs to, so deleting one later still updates
 * its deal. Stops early if it's running out of time, and picks up the rest on the next run.
 */
async function recordExistingLineItems(model: DataModel): Promise<number> {
    const pageSize = 500
    const startedAt = Date.now()
    let recorded = 0
    for (let offset = 0; Date.now() - startedAt < 15000; offset += pageSize) {
        const page = await queryRecords({
            objectSlug: model.slugs.lineItems,
            limit: pageSize,
            offset,
        })
        for (let i = 0; i < page.length; i += 25) {
            await Promise.all(
                page.slice(i, i + 25).map(async (lineItem) => {
                    const dealId = readDealId(lineItem.values)
                    if (dealId) {
                        await kv.set(KV_KEYS.lineItemDeal(lineItem.id.record_id), dealId)
                        recorded++
                    }
                })
            )
        }
        if (page.length < pageSize) {
            break
        }
    }
    return recorded
}

/**
 * A new price attribute copies the currency of the existing product or line item price, so
 * prices copy across unchanged. If neither exists yet, it uses the currency of the Deal value.
 */
function pickCurrency({
    attributesByObject,
    model,
}: {
    attributesByObject: Map<ObjectKey, Map<string, AttioAttribute>>
    model: DataModel
}): string {
    const candidates = [
        attributesByObject.get("products")?.get(model.product.priceSlug),
        attributesByObject.get("lineItems")?.get(LINE_ITEM_ATTRIBUTES.listPrice),
        attributesByObject.get("deals")?.get("value"),
    ]
    for (const attribute of candidates) {
        const code = attribute?.config.currency?.default_currency_code
        if (attribute?.type === "currency" && !attribute.is_archived && code) {
            return code
        }
    }
    return FALLBACK_CURRENCY
}

function buildAttribute({
    requirement,
    currency,
    model,
}: {
    requirement: AttributeRequirement
    currency: string
    model: DataModel
}): NewAttribute {
    const base = {title: requirement.title, api_slug: requirement.slug, is_multiselect: false}
    switch (requirement.type) {
        case "text":
        case "number":
            return {...base, type: requirement.type, config: {}}
        case "currency":
            return {
                ...base,
                type: "currency",
                config: {currency: {default_currency_code: currency, display_type: "symbol"}},
            }
        case "record-reference": {
            const target = model.slugs[requirement.targetObject ?? "products"]
            return {
                ...base,
                type: "record-reference",
                config: {record_reference: {allowed_objects: [target]}},
                relationship: requirement.inverse
                    ? {
                          object: target,
                          title: requirement.inverse.title,
                          api_slug: requirement.inverse.slug,
                          is_multiselect: true,
                      }
                    : undefined,
            }
        }
    }
}
