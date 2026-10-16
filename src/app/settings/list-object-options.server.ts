import {listObjects} from "../../attio/rest"
import {DEALS_OBJECT, LINE_ITEMS_OBJECT} from "../../utils/line-item-schema"

export interface SettingsOption {
    value: string
    label: string
    description?: string
}

/** Objects an admin can pick as the products object. Returns `[]` if they can't be loaded. */
export default async function listObjectOptions(): Promise<Array<SettingsOption>> {
    try {
        const objects = await listObjects()
        return objects
            .filter(
                (object): object is {api_slug: string; plural_noun: string | null} =>
                    object.api_slug !== null &&
                    object.api_slug !== LINE_ITEMS_OBJECT &&
                    object.api_slug !== DEALS_OBJECT
            )
            .map((object) => ({
                value: object.api_slug,
                label: object.plural_noun ?? object.api_slug,
                description: object.api_slug,
            }))
    } catch (error) {
        console.error("[Settings] Failed to list objects", error)
        return []
    }
}
