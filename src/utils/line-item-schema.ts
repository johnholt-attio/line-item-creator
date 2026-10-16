/**
 * The workspace data model this app depends on.
 *
 * Products and Line items are custom objects that don't exist by default: an admin creates them,
 * or the app's automatic setup does. A workspace may have created its own Products object with
 * different slugs, so an admin can point the app at it from the settings page. Line items' slugs
 * are fixed. The setup check compares the workspace against `buildDataModel()` so the dialog can
 * explain exactly what is missing.
 */

export type ObjectKey = "products" | "lineItems" | "deals"

export const DEFAULT_PRODUCT_MAPPING = {
    objectSlug: "products",
    nameSlug: "name",
    priceSlug: "list_price",
} as const

export const LINE_ITEMS_OBJECT = "line_items"
export const DEALS_OBJECT = "deals"

export const LINE_ITEM_ATTRIBUTES = {
    name: "name",
    product: "product",
    deal: "deal",
    quantity: "quantity",
    listPrice: "list_price",
    discountPercent: "discount_percent",
    lineTotal: "line_total",
} as const

export const DEAL_ATTRIBUTES = {
    lineItemsTotal: "line_items_total",
    /** The standard Deal value attribute. */
    value: "value",
    /** The standard Deal owner attribute: a fallback comment author. */
    owner: "owner",
} as const

export type AttributeType = "text" | "number" | "currency" | "record-reference"

/** A Products attribute the admin can choose in the app's settings. */
export type ProductSetting = "name" | "price"

export interface AttributeRequirement {
    object: ObjectKey
    slug: string
    /** Suggested display name, shown in setup guidance. */
    title: string
    type: AttributeType
    /** For record references: the object the attribute must point at. */
    targetObject?: ObjectKey
    /** Whether the app writes this attribute when creating a line item. */
    writable: boolean
    /** For relationships: the reverse attribute created on the target object. */
    inverse?: {slug: string; title: string}
    /** Set for Products attributes an admin can choose in the app's settings. */
    setting?: ProductSetting
}

export interface DataModel {
    /** API slug of each object. */
    slugs: Record<ObjectKey, string>
    product: {nameSlug: string; priceSlug: string}
    /** Which Products choices an admin has made explicitly in settings. */
    configured: {object: boolean; name: boolean; price: boolean}
    /** Attributes the app reads or writes. Without these it cannot work. */
    required: Array<AttributeRequirement>
    dealValue: {
        /** Whether the app calculates Deal value from line items. */
        sync: boolean
        /** Workspace member the app's comments are posted as, if chosen in settings. */
        commentAuthorId: string | null
    }
}

export const OBJECT_TITLES: Record<ObjectKey, string> = {
    products: "Products",
    lineItems: "Line items",
    deals: "Deals",
}

export const SETTINGS_LOCATION = "the app's settings (Workspace settings → Apps)"

export function buildDataModel(settings: {
    products_object: string | null
    product_name_attribute: string | null
    product_price_attribute: string | null
    deal_value_sync: boolean | null
    comment_author: string | null
}): DataModel {
    const productsSlug = settings.products_object || DEFAULT_PRODUCT_MAPPING.objectSlug
    const nameSlug = settings.product_name_attribute || DEFAULT_PRODUCT_MAPPING.nameSlug
    const priceSlug = settings.product_price_attribute || DEFAULT_PRODUCT_MAPPING.priceSlug

    return {
        slugs: {products: productsSlug, lineItems: LINE_ITEMS_OBJECT, deals: DEALS_OBJECT},
        product: {nameSlug, priceSlug},
        configured: {
            object: Boolean(settings.products_object),
            name: Boolean(settings.product_name_attribute),
            price: Boolean(settings.product_price_attribute),
        },
        dealValue: {
            sync: settings.deal_value_sync === true,
            commentAuthorId: settings.comment_author || null,
        },
        required: [
            {
                object: "products",
                slug: nameSlug,
                title: "Name",
                type: "text",
                writable: false,
                setting: "name",
            },
            {
                object: "products",
                slug: priceSlug,
                title: "List price",
                type: "currency",
                writable: false,
                setting: "price",
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.name,
                title: "Name",
                type: "text",
                writable: true,
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.product,
                title: "Product",
                type: "record-reference",
                targetObject: "products",
                writable: true,
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.deal,
                title: "Deal",
                type: "record-reference",
                targetObject: "deals",
                writable: true,
                inverse: {slug: "line_items", title: "Line items"},
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.quantity,
                title: "Quantity",
                type: "number",
                writable: true,
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.listPrice,
                title: "List price",
                type: "currency",
                writable: true,
            },
            {
                object: "lineItems",
                slug: LINE_ITEM_ATTRIBUTES.discountPercent,
                title: "Discount %",
                type: "number",
                writable: true,
            },
        ],
    }
}

/**
 * Formula attributes the app never touches. Line items still save without them, so a missing one
 * is reported as a warning rather than blocking the form.
 */
export const RECOMMENDED_ATTRIBUTES: Array<{
    object: ObjectKey
    slug: string
    title: string
    hint: string
}> = [
    {
        object: "lineItems",
        slug: LINE_ITEM_ATTRIBUTES.lineTotal,
        title: "Line total",
        hint: "a formula: Quantity × List price × (1 − Discount % / 100)",
    },
    {
        object: "deals",
        slug: DEAL_ATTRIBUTES.lineItemsTotal,
        title: "Line items total",
        hint: "a formula summing Line total across the deal's line items",
    },
]
