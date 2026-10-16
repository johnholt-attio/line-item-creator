import {getCurrentUser} from "attio/server"
import {AttioApiError, getWorkspaceMemberAccessLevel} from "../../../attio/rest"

export type AdminCheck = {isAdmin: true} | {isAdmin: false; reason: string}

/**
 * Whether the person using the app is a workspace admin.
 *
 * This runs on the server, using the user Attio says is signed in, so it can't be bypassed by
 * the client. The app's API token can change the data model on its own, so this check is what
 * stops non-admins from doing that through the app.
 */
export async function checkCurrentUserIsAdmin(): Promise<AdminCheck> {
    const user = getCurrentUser()
    if (!user) {
        return {isAdmin: false, reason: "The app couldn't tell who is signed in."}
    }
    try {
        const accessLevel = await getWorkspaceMemberAccessLevel(user.id)
        if (accessLevel === "admin") {
            return {isAdmin: true}
        }
        if (accessLevel === null) {
            console.error("[Admin check] Signed-in user isn't a known workspace member")
            return {
                isAdmin: false,
                reason: "The app couldn't find your workspace membership, so it can't confirm you're an admin.",
            }
        }
        return {
            isAdmin: false,
            reason: "Only workspace admins can set this up automatically. Ask an admin to open this dialog, or to make the changes below by hand.",
        }
    } catch (error) {
        console.error("[Admin check] Failed to look up workspace member", error)
        if (error instanceof AttioApiError && error.status === 403) {
            return {
                isAdmin: false,
                reason: "The app can't confirm you're an admin because it's missing the user_management:read scope.",
            }
        }
        return {isAdmin: false, reason: "The app couldn't confirm you're an admin. Try again."}
    }
}
