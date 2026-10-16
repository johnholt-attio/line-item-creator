import {AttioApiError} from "./rest"

/** Turns an error from the Attio API into a message that's safe and useful to show a user. */
export function describeApiError(error: unknown): string {
    if (error instanceof AttioApiError) {
        if (error.status === 401) {
            return "The app couldn't sign in to Attio. Try reinstalling the app in this workspace."
        }
        if (error.status === 403) {
            return "The app doesn't have the permissions it needs. Its developer must grant the record_permission:read-write, object_configuration:read-write, user_management:read, webhook:read-write and comment:read-write scopes, then reinstall the app."
        }
        if (error.status === 429) {
            return "Attio is rate limiting requests. Wait a moment and try again."
        }
        if (error.status >= 500) {
            return "Attio is having trouble right now. Try again in a moment."
        }
        return error.message
    }
    return "Something went wrong. Try again in a moment."
}
