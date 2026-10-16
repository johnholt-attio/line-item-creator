import {Settings} from "attio"

/**
 * Every value is `null` until an admin sets it.
 *
 * - Products: which existing Products data the app reads. `null` means the default slug
 *   (`products`, `name`, `list_price`).
 * - Deal value: whether the app calculates Deal value from line items, and which workspace member
 *   its comments are posted as (the Comments API only accepts workspace members as authors).
 *
 * @see https://docs.attio.com/sdk/guides/adding-workspace-settings
 */
export default Settings.defineWorkspaceSchema({
    products_object: Settings.Schema.string(),
    product_name_attribute: Settings.Schema.string(),
    product_price_attribute: Settings.Schema.string(),
    deal_value_sync: Settings.Schema.boolean(),
    comment_author: Settings.Schema.string(),
})
