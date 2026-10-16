import {listWorkspaceMembers} from "../../attio/rest"

export interface MemberOption {
    value: string
    label: string
    description?: string
    avatarUrl: string | null
}

/**
 * Active workspace members, for the "Post comments as" picker. Suspended members are left out,
 * since they can't author comments. Returns `[]` if members can't be loaded.
 */
export default async function listMemberOptions(): Promise<Array<MemberOption>> {
    try {
        const members = await listWorkspaceMembers()
        return members
            .filter((member) => member.accessLevel !== "suspended")
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((member) => ({
                value: member.id,
                label: member.name,
                description: member.accessLevel === "admin" ? "Admin" : undefined,
                avatarUrl: member.avatarUrl,
            }))
    } catch (error) {
        console.error("[Settings] Failed to list workspace members", error)
        return []
    }
}
