import {Settings} from "attio/server"
import type {DataModel} from "../../../utils/line-item-schema"
import {buildDataModel} from "../../../utils/line-item-schema"
import schema from "../../settings/schema"

/** Reads the admin's choices from the app's settings, falling back to the default slugs. */
export async function loadDataModel(): Promise<DataModel> {
    return buildDataModel(await Settings.getSettings(schema))
}
