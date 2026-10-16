import {listAttributes} from "../../attio/rest"
import type {SettingsOption} from "./list-object-options.server"

/**
 * Active attributes of one type on an object, for the settings page's attribute pickers. Returns
 * `[]` if they can't be loaded.
 */
export default async function listAttributeOptions({
    objectSlug,
    type,
}: {
    objectSlug: string
    type: "text" | "currency"
}): Promise<Array<SettingsOption>> {
    try {
        const attributes = await listAttributes(objectSlug)
        return attributes
            .filter((attribute) => attribute.type === type && !attribute.is_archived)
            .map((attribute) => ({
                value: attribute.api_slug,
                label: attribute.title,
                description:
                    type === "currency" && attribute.config.currency?.default_currency_code
                        ? `${attribute.api_slug} · ${attribute.config.currency.default_currency_code}`
                        : attribute.api_slug,
            }))
    } catch (error) {
        console.error("[Settings] Failed to list attributes", error)
        return []
    }
}
