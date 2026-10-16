import {getWebhookConfig} from "../../../attio/deal-value-sync"
import type {AttioAttribute} from "../../../attio/rest"
import type {AttioRecord} from "../../../attio/rest"
import {getObject, getWebhookStatus, listAttributes, queryRecords} from "../../../attio/rest"
import type {AttributeRequirement, DataModel, ObjectKey} from "../../../utils/line-item-schema"
import {
    DEAL_ATTRIBUTES,
    LINE_ITEM_ATTRIBUTES,
    OBJECT_TITLES,
    RECOMMENDED_ATTRIBUTES,
    SETTINGS_LOCATION,
} from "../../../utils/line-item-schema"

/** A change the app can make itself, given `object_configuration:read-write`. */
export type AutoFix =
    | {kind: "create-object"; object: ObjectKey}
    /** Registers the webhook that keeps Deal value in step with line items. */
    | {kind: "register-webhook"}
    /** Points the app's settings at the Products attribute that actually holds the data. */
    | {kind: "use-product-attribute"; setting: "name" | "price"; slug: string; title: string}
    | {kind: "create-attribute"; requirement: AttributeRequirement}
    | {kind: "restore-attribute"; object: ObjectKey; slug: string}
    | {
          /**
           * Moves a wrongly configured attribute out of the way: renames its API slug and
           * archives it (its data is kept), then creates a correct attribute in its place.
           */
          kind: "replace-attribute"
          requirement: AttributeRequirement
          currentTitle: string
          oldSlug: string
          /** The other side of the old attribute, if it was a relationship. */
          oldInverse: {objectSlug: string; slug: string; oldSlug: string} | null
      }

export interface SetupIssue {
    id: string
    object: ObjectKey
    problem: string
    fix: string
    /** Set when "Set up automatically" can resolve this issue. */
    autoFix: AutoFix | null
}

export interface SetupAnalysis {
    issues: Array<SetupIssue>
    warnings: Array<SetupIssue>
    attributesByObject: Map<ObjectKey, Map<string, AttioAttribute>>
    objectIds: Map<ObjectKey, string>
}

type AttributesByObject = Map<ObjectKey, Map<string, AttioAttribute>>

const OBJECT_KEYS: Array<ObjectKey> = ["products", "lineItems", "deals"]

/**
 * Compares the workspace's objects and attributes against what the app needs. Shared by the
 * setup check and the automatic setup, so both always agree on what's missing.
 */
export async function analyzeSetup(model: DataModel): Promise<SetupAnalysis> {
    const issues: Array<SetupIssue> = []
    const warnings: Array<SetupIssue> = []

    const objects = await Promise.all(OBJECT_KEYS.map((key) => getObject(model.slugs[key])))
    const objectIds = new Map<ObjectKey, string>()
    OBJECT_KEYS.forEach((key, index) => {
        const object = objects[index]
        if (object) {
            objectIds.set(key, object.id.object_id)
        } else {
            issues.push(missingObjectIssue({key, model}))
        }
    })

    const attributesByObject: AttributesByObject = new Map()
    await Promise.all(
        Array.from(objectIds.keys()).map(async (key) => {
            const attributes = await listAttributes(model.slugs[key])
            attributesByObject.set(key, new Map(attributes.map((a) => [a.api_slug, a])))
        })
    )

    for (const requirement of model.required) {
        const attributes = attributesByObject.get(requirement.object)
        if (!attributes) {
            // The object itself is missing. Its attributes are created along with it.
            continue
        }
        const issue = checkAttribute({
            requirement,
            attribute: attributes.get(requirement.slug),
            objectIds,
            attributesByObject,
            model,
        })
        if (issue) {
            issues.push(issue)
        }
    }

    const productAttributes = attributesByObject.get("products")
    if (productAttributes) {
        const products = await queryRecords({
            objectSlug: model.slugs.products,
            limit: PRODUCT_SAMPLE_SIZE,
        })
        for (const requirement of model.required) {
            if (requirement.setting) {
                checkProductData({
                    requirement,
                    attributes: productAttributes,
                    products,
                    model,
                    issues,
                    warnings,
                })
            }
        }
    }

    const currencyIssue = checkCurrenciesMatch({attributesByObject, model})
    if (currencyIssue) {
        issues.push(currencyIssue)
    }

    issues.push(
        ...checkUnfillableRequiredAttributes({
            attributes: attributesByObject.get("lineItems"),
            model,
        })
    )

    if (model.dealValue.sync) {
        const sync = await checkDealValueSync({attributesByObject, model})
        issues.push(...sync.issues)
        warnings.push(...sync.warnings)
    }

    for (const recommended of RECOMMENDED_ATTRIBUTES) {
        const attributes = attributesByObject.get(recommended.object)
        if (!attributes) {
            continue
        }
        // With the sync on, Line total is required (checked above) and Line items total is
        // redundant, since the app writes the sum straight into Deal value.
        if (model.dealValue.sync) {
            continue
        }
        // Formulas are added by hand, so also accept a similar title under a different slug,
        // for example "Line totals" (`line_totals`).
        const attribute =
            attributes.get(recommended.slug) ??
            Array.from(attributes.values()).find(
                (a) =>
                    !a.is_archived && normalizeTitle(a.title) === normalizeTitle(recommended.title)
            )
        if (!attribute || attribute.is_archived) {
            warnings.push({
                id: `${recommended.object}.${recommended.slug}.recommended`,
                object: recommended.object,
                problem: `${OBJECT_TITLES[recommended.object]} has no "${recommended.title}" attribute (\`${recommended.slug}\`).`,
                fix: `Line items will still save. To see totals, add ${recommended.hint}. Formulas can't be created automatically.`,
                autoFix: null,
            })
        }
    }

    return {issues, warnings, attributesByObject, objectIds}
}

/** Extra requirements when "Calculate deal value from line items" is on. */
async function checkDealValueSync({
    attributesByObject,
    model,
}: {
    attributesByObject: AttributesByObject
    model: DataModel
}): Promise<{issues: Array<SetupIssue>; warnings: Array<SetupIssue>}> {
    const issues: Array<SetupIssue> = []
    const warnings: Array<SetupIssue> = []
    const lineItemAttributes = attributesByObject.get("lineItems")
    const dealAttributes = attributesByObject.get("deals")

    // Deal value is the sum of Line total, read by its exact slug.
    if (lineItemAttributes) {
        const lineTotal = lineItemAttributes.get(LINE_ITEM_ATTRIBUTES.lineTotal)
        if (!lineTotal || lineTotal.is_archived) {
            const similar = Array.from(lineItemAttributes.values()).find(
                (a) => !a.is_archived && normalizeTitle(a.title) === normalizeTitle("Line total")
            )
            issues.push({
                id: "sync.line-total",
                object: "lineItems",
                problem: similar
                    ? `"${similar.title}" on Line items has the API slug \`${similar.api_slug}\`, but calculating Deal value needs it to be \`${LINE_ITEM_ATTRIBUTES.lineTotal}\`.`
                    : `Calculating Deal value needs a "Line total" attribute (\`${LINE_ITEM_ATTRIBUTES.lineTotal}\`) on Line items.`,
                fix: similar
                    ? `Change its API slug to \`${LINE_ITEM_ATTRIBUTES.lineTotal}\` in its settings.`
                    : `Add a formula attribute: Quantity × List price × (1 − Discount % / 100). Formulas can't be created automatically.`,
                autoFix: null,
            })
        }
    }

    // Line totals have no currency of their own, so Deal value must use the line item currency.
    const dealValue = dealAttributes?.get(DEAL_ATTRIBUTES.value)
    const lineItemPrice = lineItemAttributes?.get(LINE_ITEM_ATTRIBUTES.listPrice)
    if (dealAttributes && (!dealValue || dealValue.type !== "currency")) {
        issues.push({
            id: "sync.deal-value",
            object: "deals",
            problem: "Deals has no Currency attribute with the API slug `value`.",
            fix: "Restore the standard Deal value attribute, or turn off calculating deal value in the app's settings.",
            autoFix: null,
        })
    } else if (dealValue && lineItemPrice?.type === "currency") {
        const dealCode = dealValue.config.currency?.default_currency_code ?? null
        const lineItemCode = lineItemPrice.config.currency?.default_currency_code ?? null
        if (dealCode !== lineItemCode) {
            issues.push({
                id: "sync.deal-currency",
                object: "deals",
                problem: `Deal value uses ${dealCode ?? "no currency"}, but line item prices use ${lineItemCode ?? "no currency"}.`,
                fix: "Set them to the same currency, so the total isn't recorded in the wrong currency.",
                autoFix: null,
            })
        }
    }

    const config = await getWebhookConfig()
    const status = config ? await getWebhookStatus(config.webhookId) : null
    if (!config || status === null || status === "inactive") {
        issues.push({
            id: "sync.webhook",
            object: "deals",
            problem: config
                ? "The webhook that keeps Deal value up to date has stopped working."
                : "Deal value can't be calculated yet: the app hasn't registered its webhook.",
            fix: "An admin needs to select Set up automatically. It can't be done by hand.",
            autoFix: {kind: "register-webhook"},
        })
    }

    if (!model.dealValue.commentAuthorId) {
        warnings.push({
            id: "sync.comment-author",
            object: "deals",
            problem: "No member is chosen under Post comments as in the app's settings.",
            fix: "Comments about Deal value changes are posted as the admin who last ran Set up automatically, or the deal owner when that admin made the change.",
            autoFix: null,
        })
    }

    return {issues, warnings}
}

/** Short descriptions of every change "Set up automatically" would make, in order. */
export function describePlannedChanges({
    issues,
    model,
}: {
    issues: Array<SetupIssue>
    model: DataModel
}): Array<string> {
    const changes: Array<string> = []
    for (const issue of issues) {
        const fix = issue.autoFix
        if (!fix) {
            continue
        }
        switch (fix.kind) {
            case "create-object":
                changes.push(
                    `Create the ${OBJECT_TITLES[fix.object]} object (\`${model.slugs[fix.object]}\`)`
                )
                for (const requirement of model.required) {
                    if (requirement.object === fix.object) {
                        changes.push(describeAttributeCreation(requirement))
                    }
                }
                break
            case "create-attribute":
                changes.push(describeAttributeCreation(fix.requirement))
                break
            case "replace-attribute":
                changes.push(
                    `Rename the current "${fix.currentTitle}" on ${OBJECT_TITLES[fix.requirement.object]} to \`${fix.oldSlug}\` and archive it. Its data is kept.`
                )
                if (fix.oldInverse) {
                    changes.push(
                        `Do the same for the other side of that relationship (\`${fix.oldInverse.slug}\` → \`${fix.oldInverse.oldSlug}\`)`
                    )
                }
                changes.push(describeAttributeCreation(fix.requirement))
                break
            case "use-product-attribute":
                changes.push(
                    `Use "${fix.title}" (\`${fix.slug}\`) as the product ${fix.setting} in the app's settings`
                )
                break
            case "register-webhook":
                changes.push(
                    "Register a webhook so Deal value is calculated from line items. Turn off any workflow that also sets Deal value, or they'll overwrite each other.",
                    "Record which deal each existing line item belongs to"
                )
                break
            case "restore-attribute":
                changes.push(
                    `Restore the archived \`${fix.slug}\` attribute on ${OBJECT_TITLES[fix.object]}`
                )
                break
        }
    }
    return changes
}

function describeAttributeCreation(requirement: AttributeRequirement): string {
    const base = `Add "${requirement.title}" (${describeType(requirement)}) to ${OBJECT_TITLES[requirement.object]}`
    return requirement.inverse
        ? `${base}, with "${requirement.inverse.title}" added to Deals`
        : base
}

function missingObjectIssue({key, model}: {key: ObjectKey; model: DataModel}): SetupIssue {
    const slug = model.slugs[key]
    if (key === "deals") {
        return {
            id: "deals.object",
            object: key,
            problem: "The Deals object isn't enabled in this workspace.",
            fix: "Enable Deals in Workspace settings → Objects.",
            autoFix: null,
        }
    }
    if (key === "products" && model.configured.object) {
        return {
            id: "products.object",
            object: key,
            problem: `The products object chosen in the app's settings (\`${slug}\`) doesn't exist any more.`,
            fix: `Choose another object in ${SETTINGS_LOCATION}.`,
            autoFix: null,
        }
    }
    const settingsHint =
        key === "products"
            ? ` If your products already live in an object with a different slug, choose it in ${SETTINGS_LOCATION} instead.`
            : ""
    return {
        id: `${key}.object`,
        object: key,
        problem: `There's no ${OBJECT_TITLES[key]} object (\`${slug}\`).`,
        fix: `Create a custom object called "${OBJECT_TITLES[key]}" with the API slug \`${slug}\` in Workspace settings → Objects.${settingsHint}`,
        autoFix: {kind: "create-object", object: key},
    }
}

export function describeType(requirement: AttributeRequirement): string {
    switch (requirement.type) {
        case "text":
            return "Text"
        case "number":
            return "Number"
        case "currency":
            return "Currency"
        case "record-reference":
            return requirement.targetObject === "deals"
                ? "Relationship (to one Deal)"
                : `Record (single, pointing to ${OBJECT_TITLES[requirement.targetObject ?? "products"]})`
    }
}

function settingLabel(setting: "name" | "price"): string {
    return setting === "name" ? "Product name attribute" : "Product price attribute"
}

const PRODUCT_SAMPLE_SIZE = 200

/** Whether a product has a usable value in an attribute: non-blank text, or a currency amount. */
function hasValue(product: AttioRecord, slug: string): boolean {
    return (product.values[slug] ?? []).some((value) => {
        if (typeof value !== "object" || value === null) {
            return false
        }
        const record = value as Record<string, unknown>
        if (typeof record.value === "string") {
            return record.value.trim() !== ""
        }
        return record.currency_value !== null && record.currency_value !== undefined
    })
}

/**
 * Products often end up with more than one attribute that could hold the name or price, for
 * example an empty `list_price` next to a `price` that has the real data. Compares how many
 * sampled products have a value in each candidate, and either points the admin at the one with
 * data, or notes which one the app uses when several have data.
 *
 * Replaces the generic issue for this requirement when the data gives a better answer.
 */
function checkProductData({
    requirement,
    attributes,
    products,
    model,
    issues,
    warnings,
}: {
    requirement: AttributeRequirement
    attributes: Map<string, AttioAttribute>
    products: Array<AttioRecord>
    model: DataModel
    issues: Array<SetupIssue>
    warnings: Array<SetupIssue>
}): void {
    const setting = requirement.setting
    if (!setting || products.length === 0) {
        return // Nothing to compare yet.
    }
    const candidates = Array.from(attributes.values()).filter(
        (a) => a.type === requirement.type && !a.is_archived
    )
    if (candidates.length < 2 && attributes.has(requirement.slug)) {
        return
    }

    const counts = new Map(
        candidates.map((a) => [a.api_slug, products.filter((p) => hasValue(p, a.api_slug)).length])
    )
    const chosen = attributes.get(requirement.slug)
    const chosenUsable =
        chosen !== undefined && chosen.type === requirement.type && !chosen.is_archived
    const chosenCount = chosenUsable ? (counts.get(requirement.slug) ?? 0) : 0
    const others = candidates
        .filter((a) => a.api_slug !== requirement.slug && (counts.get(a.api_slug) ?? 0) > 0)
        .sort((a, b) => (counts.get(b.api_slug) ?? 0) - (counts.get(a.api_slug) ?? 0))

    const sampled =
        products.length < PRODUCT_SAMPLE_SIZE
            ? `all ${products.length} products`
            : `the first ${products.length} products`
    const isConfigured = model.configured[setting]
    const id = `${requirement.object}.${requirement.slug}`
    const existingIndex = issues.findIndex((issue) => issue.id === id)

    // Whether something else holds the data while the chosen attribute is empty or unusable.
    if (chosenCount === 0 && others.length > 0) {
        const best = pickBest({others, counts, setting})
        const describe = (a: AttioAttribute) =>
            `"${a.title}" (\`${a.api_slug}\`, ${counts.get(a.api_slug)} of ${products.length})`
        const issue: SetupIssue = {
            id,
            object: "products",
            problem: `${chosenUsable && chosen ? `"${chosen.title}" (\`${requirement.slug}\`) is empty on ${sampled}` : `Products has no usable \`${requirement.slug}\` attribute`}, but other attributes hold the product's ${setting}: ${others.map(describe).join(", ")}.`,
            fix:
                best && !isConfigured
                    ? `Choose "${best.title}" as ${settingLabel(setting)} in ${SETTINGS_LOCATION}.`
                    : `Choose the attribute that holds the product's ${setting} as ${settingLabel(setting)} in ${SETTINGS_LOCATION}.`,
            // Only switch automatically when the admin hasn't chosen in settings and the answer
            // is clear.
            autoFix:
                best && !isConfigured
                    ? {
                          kind: "use-product-attribute",
                          setting,
                          slug: best.api_slug,
                          title: best.title,
                      }
                    : null,
        }
        if (existingIndex >= 0) {
            issues[existingIndex] = issue
        } else {
            issues.push(issue)
        }
        return
    }

    // Several attributes have data. Only worth a note if the admin hasn't chosen explicitly.
    if (chosenUsable && chosen && chosenCount > 0 && others.length > 0 && !isConfigured) {
        warnings.push({
            id: `${id}.ambiguous`,
            object: "products",
            problem: `Products has more than one ${requirement.type === "currency" ? "Currency" : "Text"} attribute with values. The app uses "${chosen.title}" (\`${requirement.slug}\`) for the product's ${setting}, but "${others[0].title}" (\`${others[0].api_slug}\`) also has values.`,
            fix: `If that's the wrong one, choose another as ${settingLabel(setting)} in ${SETTINGS_LOCATION}.`,
            autoFix: null,
        })
    }
}

/**
 * The candidate with the most values. A tie is broken by a title that mentions what's being
 * looked for (like "Product name" or "Price"); otherwise there's no clear answer.
 */
function pickBest({
    others,
    counts,
    setting,
}: {
    others: Array<AttioAttribute>
    counts: Map<string, number>
    setting: "name" | "price"
}): AttioAttribute | null {
    const hint = setting === "name" ? /name|title/i : /price|cost|amount/i
    const top = counts.get(others[0].api_slug) ?? 0
    const tied = others.filter((a) => (counts.get(a.api_slug) ?? 0) === top)
    if (tied.length === 1) {
        return tied[0]
    }
    const hinted = tied.filter((a) => hint.test(a.title) || hint.test(a.api_slug))
    return hinted.length === 1 ? hinted[0] : null
}

function checkAttribute({
    requirement,
    attribute,
    objectIds,
    attributesByObject,
    model,
}: {
    requirement: AttributeRequirement
    attribute: AttioAttribute | undefined
    objectIds: Map<ObjectKey, string>
    attributesByObject: AttributesByObject
    model: DataModel
}): SetupIssue | null {
    const objectTitle = OBJECT_TITLES[requirement.object]
    const id = `${requirement.object}.${requirement.slug}`
    const typeName = describeType(requirement)
    const isConfigured = requirement.setting ? model.configured[requirement.setting] : false

    if (!attribute) {
        if (requirement.setting && isConfigured) {
            return {
                id,
                object: requirement.object,
                problem: `The attribute chosen as ${settingLabel(requirement.setting)} (\`${requirement.slug}\`) doesn't exist on ${objectTitle} any more.`,
                fix: `Choose another one in ${SETTINGS_LOCATION}.`,
                autoFix: null,
            }
        }
        // If the Products object already has an attribute of this type, it may hold the name or
        // price under another slug. Creating a new, empty one would leave every product without a
        // name or price, so point the admin at the settings page instead.
        const candidates = requirement.setting
            ? Array.from(attributesByObject.get(requirement.object)?.values() ?? []).filter(
                  (a) => a.type === requirement.type && !a.is_archived
              )
            : []
        if (requirement.setting && candidates.length > 0) {
            const names = candidates.map((a) => `"${a.title}" (\`${a.api_slug}\`)`).join(", ")
            return {
                id,
                object: requirement.object,
                problem: `${objectTitle} has no \`${requirement.slug}\` attribute, but it has other ${typeName} attributes: ${names}.`,
                fix: `If one of those holds the product's ${requirement.setting}, choose it as ${settingLabel(requirement.setting)} in ${SETTINGS_LOCATION}. Otherwise add a ${typeName} attribute with the API slug \`${requirement.slug}\`.`,
                autoFix: null,
            }
        }
        return {
            id,
            object: requirement.object,
            problem: `${objectTitle} is missing the "${requirement.title}" attribute.`,
            fix: `Add a ${typeName} attribute called "${requirement.title}" with the API slug \`${requirement.slug}\`.`,
            autoFix: {kind: "create-attribute", requirement},
        }
    }

    const label = `"${attribute.title}" (\`${requirement.slug}\`) on ${objectTitle}`
    const shapeProblem = describeShapeProblem({requirement, attribute, objectIds})

    if (shapeProblem && requirement.setting && isConfigured) {
        return {
            id,
            object: requirement.object,
            problem: `${label}, chosen as ${settingLabel(requirement.setting)}, ${shapeProblem}`,
            fix: `Choose a different attribute in ${SETTINGS_LOCATION}.`,
            autoFix: null,
        }
    }

    // A wrongly configured attribute can't be fixed by restoring it, and archiving it doesn't free
    // its API slug. The way out is to rename it and archive it, then create a correct one.
    if (shapeProblem) {
        const oldSlug = unusedSlug(
            `${requirement.slug}_old`,
            attributesByObject.get(requirement.object)
        )
        const oldInverse = attribute.relationship
            ? {
                  objectSlug: attribute.relationship.object_slug,
                  slug: attribute.relationship.api_slug,
                  oldSlug: unusedSlug(
                      `${attribute.relationship.api_slug}_old`,
                      attributesForSlug({
                          attributesByObject,
                          model,
                          objectSlug: attribute.relationship.object_slug,
                      })
                  ),
              }
            : null
        return {
            id,
            object: requirement.object,
            problem: `${label} ${attribute.is_archived ? "is archived, and it " : ""}${shapeProblem}`,
            fix: `These settings can't be changed on an existing attribute, and archiving it doesn't free up its API slug. Rename its API slug (for example to \`${oldSlug}\`) and archive it, then add a ${typeName} attribute with the API slug \`${requirement.slug}\`.`,
            // System attributes can't be renamed or archived.
            autoFix: attribute.is_system_attribute
                ? null
                : {
                      kind: "replace-attribute",
                      requirement,
                      currentTitle: attribute.title,
                      oldSlug,
                      oldInverse,
                  },
        }
    }

    if (attribute.is_archived) {
        return {
            id,
            object: requirement.object,
            problem: `${label} is archived.`,
            fix: `Restore it from the archived attributes in ${objectTitle}'s settings.`,
            autoFix: {
                kind: "restore-attribute",
                object: requirement.object,
                slug: requirement.slug,
            },
        }
    }

    return null
}

/** What's wrong with an existing attribute's configuration, or `null` if it's usable. */
function describeShapeProblem({
    requirement,
    attribute,
    objectIds,
}: {
    requirement: AttributeRequirement
    attribute: AttioAttribute
    objectIds: Map<ObjectKey, string>
}): string | null {
    const typeName = describeType(requirement)
    if (attribute.type !== requirement.type) {
        return `is a ${attribute.type} attribute, but it needs to be ${typeName}.`
    }
    if (requirement.type === "record-reference" && requirement.targetObject) {
        const targetId = objectIds.get(requirement.targetObject)
        const allowed = attribute.config.record_reference?.allowed_object_ids ?? []
        if (targetId && allowed.length > 0 && !allowed.includes(targetId)) {
            return `doesn't point to ${OBJECT_TITLES[requirement.targetObject]}.`
        }
        if (attribute.is_multiselect) {
            const noun = requirement.targetObject === "deals" ? "deal" : "product"
            return `allows more than one ${noun} per line item, but each line item needs exactly one.`
        }
    }
    if (requirement.writable && !attribute.is_writable) {
        return "is read-only (for example, a formula), so the app can't fill it in."
    }
    return null
}

function attributesForSlug({
    attributesByObject,
    model,
    objectSlug,
}: {
    attributesByObject: AttributesByObject
    model: DataModel
    objectSlug: string
}): Map<string, AttioAttribute> | undefined {
    const key = OBJECT_KEYS.find((k) => model.slugs[k] === objectSlug)
    return key ? attributesByObject.get(key) : undefined
}

/** Lowercase, letters and digits only, without a trailing "s": "Line totals" → "linetotal". */
function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/s$/, "")
}

/** `base`, or `base_2`, `base_3`… if that slug is already taken (archived attributes included). */
function unusedSlug(base: string, attributes: Map<string, AttioAttribute> | undefined): string {
    let candidate = base
    for (let n = 2; attributes?.has(candidate); n++) {
        candidate = `${base}_${n}`
    }
    return candidate
}

/**
 * Currency values are written as bare numbers and take the currency of the attribute they're
 * written to, so the product price and the line item List price must use the same currency.
 */
function checkCurrenciesMatch({
    attributesByObject,
    model,
}: {
    attributesByObject: AttributesByObject
    model: DataModel
}): SetupIssue | null {
    const productPrice = attributesByObject.get("products")?.get(model.product.priceSlug)
    const lineItemPrice = attributesByObject.get("lineItems")?.get(LINE_ITEM_ATTRIBUTES.listPrice)
    if (productPrice?.type !== "currency" || lineItemPrice?.type !== "currency") {
        return null // Missing or mistyped attributes are reported elsewhere.
    }
    const productCode = productPrice.config.currency?.default_currency_code ?? null
    const lineItemCode = lineItemPrice.config.currency?.default_currency_code ?? null
    if (productCode === lineItemCode) {
        return null
    }
    return {
        id: "currency-mismatch",
        object: "lineItems",
        problem: `The price currencies don't match: Products' "${productPrice.title}" uses ${productCode ?? "no currency"}, Line items' List price uses ${lineItemCode ?? "no currency"}.`,
        fix: "Set both to the same currency so prices copy across unchanged.",
        autoFix: null,
    }
}

/** Required Line items attributes that the app doesn't write would make every create fail. */
function checkUnfillableRequiredAttributes({
    attributes,
    model,
}: {
    attributes: Map<string, AttioAttribute> | undefined
    model: DataModel
}): Array<SetupIssue> {
    if (!attributes) {
        return []
    }
    const written = new Set<string>(
        model.required.filter((r) => r.object === "lineItems").map((r) => r.slug)
    )
    return Array.from(attributes.values())
        .filter(
            (attribute) =>
                attribute.is_required &&
                attribute.is_writable &&
                !attribute.is_archived &&
                !attribute.is_default_value_enabled &&
                !written.has(attribute.api_slug)
        )
        .map((attribute) => ({
            id: `lineItems.${attribute.api_slug}.required`,
            object: "lineItems" as const,
            problem: `"${attribute.title}" on Line items is required, but the app doesn't fill it in.`,
            fix: "Make it optional, or give it a default value.",
            autoFix: null,
        }))
}
