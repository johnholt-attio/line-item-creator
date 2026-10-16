import {describeApiError} from "../../../attio/errors"
import type {AdminCheck} from "./admin-check"
import {checkCurrentUserIsAdmin} from "./admin-check"
import {loadDataModel} from "./data-model"
import type {SetupIssue} from "./setup-analysis"
import {analyzeSetup, describePlannedChanges} from "./setup-analysis"

export type {SetupIssue}

export type SetupStatus =
    | {
          state: "ready"
          warnings: Array<SetupIssue>
          /** API slug of the object products are picked from. */
          productsObject: string
      }
    | {
          state: "incomplete"
          issues: Array<SetupIssue>
          warnings: Array<SetupIssue>
          /** What "Set up automatically" would change. Empty if nothing can be automated. */
          plannedChanges: Array<string>
          admin: AdminCheck
      }
    | {state: "error"; message: string}

/**
 * Checks whether the workspace has the objects and attributes the app needs, and explains how to
 * fix anything that's missing. Never throws: failures come back as `{state: "error"}`.
 */
export default async function checkSetup(
    // Only used as a cache key by the dialog, so each open gets a fresh check.
    _openedAt: number
): Promise<SetupStatus> {
    try {
        const model = await loadDataModel()
        const {issues, warnings} = await analyzeSetup(model)
        if (issues.length === 0) {
            return {state: "ready", warnings, productsObject: model.slugs.products}
        }
        const plannedChanges = describePlannedChanges({issues, model})
        const admin: AdminCheck =
            plannedChanges.length > 0
                ? await checkCurrentUserIsAdmin()
                : {isAdmin: false, reason: "Nothing here can be set up automatically."}
        return {state: "incomplete", issues, warnings, plannedChanges, admin}
    } catch (error) {
        console.error("[Check setup] Failed to check workspace setup", error)
        return {state: "error", message: describeApiError(error)}
    }
}
