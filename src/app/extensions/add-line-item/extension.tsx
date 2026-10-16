/**
 * Add line item - Record action
 *
 * Adds a Line items record to a deal, copying the chosen product's current list price onto it.
 * If the workspace is missing the objects or attributes this needs, the dialog explains how to
 * set them up instead of showing the form.
 *
 * @see https://docs.attio.com/sdk/extensions/record-action
 */

import {Extensions, showDialog} from "attio/client"
import {DEALS_OBJECT} from "../../../utils/line-item-schema"
import AddLineItemDialog from "./add-line-item-dialog"

export default Extensions.defineExtension({
    id: "add-line-item",
    type: "record-action",
    label: "Add line item",
    icon: "ListPlus",
    onTrigger: async ({recordId}) => {
        // A fresh value per open, so the dialog re-checks the setup every time it opens.
        const openedAt = Date.now()
        await showDialog({
            title: "Add line item",
            Dialog: ({hideDialog}) => {
                return (
                    <AddLineItemDialog
                        dealId={recordId}
                        openedAt={openedAt}
                        hideDialog={hideDialog}
                    />
                )
            },
        })
    },
    objects: DEALS_OBJECT,
})
