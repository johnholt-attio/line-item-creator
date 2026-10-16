import {z} from "zod"
import {describeApiError} from "../../../attio/errors"
import {AttioApiError, createRecord, getAttribute, getRecord} from "../../../attio/rest"
import {LINE_ITEM_ATTRIBUTES, SETTINGS_LOCATION} from "../../../utils/line-item-schema"
import {loadDataModel} from "./data-model"

export type CreateLineItemResult =
    {ok: true; recordId: string; name: string} | {ok: false; message: string}

const TextValuesSchema = z.array(z.object({value: z.string()}))

const CurrencyValuesSchema = z.array(
    z.object({
        currency_value: z.union([z.number(), z.string()]),
        currency_code: z.string().nullable().optional(),
    })
)

/**
 * Creates a Line items record for a deal, copying the product's current list price onto it.
 *
 * This is the only place the product's price is read. The copied value is never updated
 * afterwards, so later product price changes don't affect existing line items.
 */
export default async function createLineItem({
    dealId,
    productId,
    quantity,
    discountPercent,
}: {
    dealId: string
    productId: string
    quantity: number
    discountPercent: number | null
}): Promise<CreateLineItemResult> {
    if (!Number.isFinite(quantity) || quantity < 1) {
        return {ok: false, message: "Quantity must be at least 1."}
    }
    if (
        discountPercent !== null &&
        (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100)
    ) {
        return {ok: false, message: "Discount must be between 0 and 100."}
    }

    try {
        // Read from settings on every call, never from the client, so a stale dialog can't
        // read from the wrong attribute.
        const model = await loadDataModel()
        const product = await getRecord({objectSlug: model.slugs.products, recordId: productId})
        if (!product) {
            return {ok: false, message: "That product no longer exists. Choose another product."}
        }

        const names = TextValuesSchema.safeParse(product.values[model.product.nameSlug] ?? [])
        const productName = names.success ? names.data[0]?.value : undefined
        if (!productName) {
            return {
                ok: false,
                message: `This product's name (\`${model.product.nameSlug}\`) is empty. Add a name to the product, or if names are stored in another attribute, an admin can choose it in ${SETTINGS_LOCATION}.`,
            }
        }

        const prices = CurrencyValuesSchema.safeParse(product.values[model.product.priceSlug] ?? [])
        const price = prices.success ? prices.data[0] : undefined
        const listPrice = price === undefined ? NaN : Number(price.currency_value)
        if (!Number.isFinite(listPrice)) {
            return {
                ok: false,
                message: `"${productName}" has no price in \`${model.product.priceSlug}\`. Add a price to the product, or if prices are stored in another attribute, an admin can choose it in ${SETTINGS_LOCATION}.`,
            }
        }

        // Values take the currency of the attribute they're written to, so refuse to copy a price
        // into a different currency.
        const lineItemPriceAttribute = await getAttribute({
            objectSlug: model.slugs.lineItems,
            attributeSlug: LINE_ITEM_ATTRIBUTES.listPrice,
        })
        if (!lineItemPriceAttribute) {
            return {
                ok: false,
                message: setupChangedMessage("Line items has no List price attribute."),
            }
        }
        const productCurrency = price?.currency_code ?? null
        const lineItemCurrency =
            lineItemPriceAttribute.config.currency?.default_currency_code ?? null
        if (
            productCurrency !== null &&
            lineItemCurrency !== null &&
            productCurrency !== lineItemCurrency
        ) {
            return {
                ok: false,
                message: `This product is priced in ${productCurrency}, but Line items use ${lineItemCurrency}. Ask an admin to make the price currencies match.`,
            }
        }

        const name = `${productName} × ${quantity}`
        const values: Record<string, unknown> = {
            [LINE_ITEM_ATTRIBUTES.name]: name,
            [LINE_ITEM_ATTRIBUTES.product]: [
                {target_object: model.slugs.products, target_record_id: productId},
            ],
            [LINE_ITEM_ATTRIBUTES.deal]: [
                {target_object: model.slugs.deals, target_record_id: dealId},
            ],
            [LINE_ITEM_ATTRIBUTES.quantity]: quantity,
            [LINE_ITEM_ATTRIBUTES.listPrice]: listPrice,
        }
        if (discountPercent !== null) {
            values[LINE_ITEM_ATTRIBUTES.discountPercent] = discountPercent
        }

        const record = await createRecord({objectSlug: model.slugs.lineItems, values})
        return {ok: true, recordId: record.id.record_id, name}
    } catch (error) {
        console.error("[Create line item] Failed to create line item", error)
        // A 400 or 404 here usually means an object or attribute changed after the dialog opened.
        if (error instanceof AttioApiError && (error.status === 400 || error.status === 404)) {
            return {ok: false, message: setupChangedMessage(error.message)}
        }
        return {ok: false, message: describeApiError(error)}
    }
}

function setupChangedMessage(detail: string): string {
    return `Attio rejected the line item: ${detail} The workspace setup may have changed. Close and reopen this dialog to see what needs fixing.`
}
