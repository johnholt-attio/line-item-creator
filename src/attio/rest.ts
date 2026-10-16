import {ATTIO_API_TOKEN} from "attio/server"
import {z} from "zod"

/**
 * Minimal Attio REST API client for server-side code.
 *
 * @see https://docs.attio.com/rest-api/overview
 */

const BASE_URL = "https://api.attio.com/v2"

export class AttioApiError extends Error {
    readonly status: number
    readonly code: string | null

    constructor({status, code, message}: {status: number; code: string | null; message: string}) {
        super(message)
        this.name = "AttioApiError"
        this.status = status
        this.code = code
    }
}

const ErrorBodySchema = z.object({
    code: z.string().optional(),
    message: z.string().optional(),
})

export async function attioRequest<TSchema extends z.ZodTypeAny>({
    method,
    path,
    body,
    schema,
}: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    path: string
    body?: unknown
    schema: TSchema
}): Promise<z.infer<TSchema>> {
    const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${ATTIO_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    })

    let json: unknown = null
    try {
        json = await response.json()
    } catch (_error) {
        // Fall through: a non-JSON body is handled below as a generic error.
    }

    if (!response.ok) {
        const parsed = ErrorBodySchema.safeParse(json)
        const code = parsed.success ? (parsed.data.code ?? null) : null
        const message = parsed.success ? (parsed.data.message ?? null) : null
        console.error(`[Attio API] ${method} ${path} failed (${response.status}) ${code ?? ""}`)
        throw new AttioApiError({
            status: response.status,
            code,
            message: message ?? `Attio API request failed (${response.status})`,
        })
    }

    const result = schema.safeParse(json)
    if (!result.success) {
        console.error(`[Attio API] Unexpected response shape from ${method} ${path}`, result.error)
        throw new Error("Unexpected response from the Attio API")
    }
    return result.data
}

// ---- Objects and attributes ----

const ObjectSchema = z.object({
    data: z.object({
        id: z.object({object_id: z.string()}),
        api_slug: z.string().nullable(),
    }),
})

export type AttioObject = z.infer<typeof ObjectSchema>["data"]

/** Returns the object, or `null` if no object has that slug. */
export async function getObject(slug: string): Promise<AttioObject | null> {
    try {
        const {data} = await attioRequest({
            method: "GET",
            path: `/objects/${encodeURIComponent(slug)}`,
            schema: ObjectSchema,
        })
        return data
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return null
        }
        throw error
    }
}

const ObjectListSchema = z.object({
    data: z.array(
        z.object({
            api_slug: z.string().nullable(),
            plural_noun: z.string().nullable(),
        })
    ),
})

/** Lists every object in the workspace. */
export async function listObjects(): Promise<z.infer<typeof ObjectListSchema>["data"]> {
    const {data} = await attioRequest({method: "GET", path: "/objects", schema: ObjectListSchema})
    return data
}

const AttributeSchema = z.object({
    id: z.object({attribute_id: z.string()}),
    api_slug: z.string(),
    title: z.string(),
    type: z.string(),
    is_writable: z.boolean(),
    is_required: z.boolean(),
    is_multiselect: z.boolean(),
    is_archived: z.boolean(),
    is_default_value_enabled: z.boolean(),
    is_system_attribute: z.boolean(),
    relationship: z.object({object_slug: z.string(), api_slug: z.string()}).nullable().optional(),
    config: z.object({
        currency: z.object({default_currency_code: z.string().nullable()}).nullable().optional(),
        record_reference: z
            .object({allowed_object_ids: z.array(z.string()).nullable()})
            .nullable()
            .optional(),
    }),
})

export type AttioAttribute = z.infer<typeof AttributeSchema>

const AttributeListSchema = z.object({data: z.array(AttributeSchema)})

/** Lists every attribute on an object, including archived ones. */
export async function listAttributes(objectSlug: string): Promise<Array<AttioAttribute>> {
    const attributes: Array<AttioAttribute> = []
    // The page size isn't documented, so keep paging by offset until a page comes back empty.
    for (let page = 0; page < 20; page++) {
        const {data} = await attioRequest({
            method: "GET",
            path: `/objects/${encodeURIComponent(objectSlug)}/attributes?show_archived=true&offset=${attributes.length}`,
            schema: AttributeListSchema,
        })
        if (data.length === 0) {
            break
        }
        attributes.push(...data)
    }
    return attributes
}

const SingleAttributeSchema = z.object({data: AttributeSchema})

/** Returns the attribute, or `null` if the object or attribute doesn't exist. */
export async function getAttribute({
    objectSlug,
    attributeSlug,
}: {
    objectSlug: string
    attributeSlug: string
}): Promise<AttioAttribute | null> {
    try {
        const {data} = await attioRequest({
            method: "GET",
            path: `/objects/${encodeURIComponent(objectSlug)}/attributes/${encodeURIComponent(attributeSlug)}`,
            schema: SingleAttributeSchema,
        })
        return data
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return null
        }
        throw error
    }
}

// ---- Records ----

const RecordSchema = z.object({
    data: z.object({
        id: z.object({record_id: z.string()}),
        values: z.record(z.array(z.unknown())),
    }),
})

export type AttioRecord = z.infer<typeof RecordSchema>["data"]

/** Returns the record, or `null` if it doesn't exist. */
export async function getRecord({
    objectSlug,
    recordId,
}: {
    objectSlug: string
    recordId: string
}): Promise<AttioRecord | null> {
    try {
        const {data} = await attioRequest({
            method: "GET",
            path: `/objects/${encodeURIComponent(objectSlug)}/records/${encodeURIComponent(recordId)}`,
            schema: RecordSchema,
        })
        return data
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return null
        }
        throw error
    }
}

export async function createRecord({
    objectSlug,
    values,
}: {
    objectSlug: string
    values: Record<string, unknown>
}): Promise<AttioRecord> {
    const {data} = await attioRequest({
        method: "POST",
        path: `/objects/${encodeURIComponent(objectSlug)}/records`,
        body: {data: {values}},
        schema: RecordSchema,
    })
    return data
}

// ---- Schema changes (need object_configuration:read-write) ----

export async function createObject({
    apiSlug,
    singularNoun,
    pluralNoun,
}: {
    apiSlug: string
    singularNoun: string
    pluralNoun: string
}): Promise<AttioObject> {
    const {data} = await attioRequest({
        method: "POST",
        path: "/objects",
        body: {data: {api_slug: apiSlug, singular_noun: singularNoun, plural_noun: pluralNoun}},
        schema: ObjectSchema,
    })
    return data
}

export interface NewAttribute {
    title: string
    api_slug: string
    type: string
    is_multiselect: boolean
    config: Record<string, unknown>
    relationship?: {object: string; title: string; api_slug: string; is_multiselect: boolean}
}

export async function createAttribute({
    objectSlug,
    attribute,
}: {
    objectSlug: string
    attribute: NewAttribute
}): Promise<void> {
    await attioRequest({
        method: "POST",
        path: `/objects/${encodeURIComponent(objectSlug)}/attributes`,
        body: {
            data: {
                description: null,
                is_required: false,
                is_unique: false,
                ...attribute,
            },
        },
        schema: z.unknown(),
    })
}

/** Renames and/or archives or restores an existing attribute. */
export async function updateAttribute({
    objectSlug,
    attributeSlug,
    changes,
}: {
    objectSlug: string
    attributeSlug: string
    changes: {api_slug?: string; is_archived?: boolean}
}): Promise<void> {
    await attioRequest({
        method: "PATCH",
        path: `/objects/${encodeURIComponent(objectSlug)}/attributes/${encodeURIComponent(attributeSlug)}`,
        body: {data: changes},
        schema: z.unknown(),
    })
}

// ---- Workspace members (need user_management:read) ----

const WorkspaceMemberSchema = z.object({
    data: z.object({access_level: z.string(), email_address: z.string()}),
})

export interface WorkspaceMember {
    accessLevel: string
    /** Used only to mention the member in comments. Never log it. */
    emailAddress: string
}

/** Returns the workspace member, or `null` if no such member exists. */
export async function getWorkspaceMember(memberId: string): Promise<WorkspaceMember | null> {
    try {
        const {data} = await attioRequest({
            method: "GET",
            path: `/workspace_members/${encodeURIComponent(memberId)}`,
            schema: WorkspaceMemberSchema,
        })
        return {accessLevel: data.access_level, emailAddress: data.email_address}
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return null
        }
        throw error
    }
}

const WorkspaceMemberListSchema = z.object({
    data: z.array(
        z.object({
            id: z.object({workspace_member_id: z.string()}),
            first_name: z.string().nullable(),
            last_name: z.string().nullable(),
            avatar_url: z.string().nullable(),
            access_level: z.string(),
        })
    ),
})

export interface WorkspaceMemberSummary {
    id: string
    name: string
    avatarUrl: string | null
    accessLevel: string
}

/** Lists every workspace member, including suspended ones. */
export async function listWorkspaceMembers(): Promise<Array<WorkspaceMemberSummary>> {
    const {data} = await attioRequest({
        method: "GET",
        path: "/workspace_members",
        schema: WorkspaceMemberListSchema,
    })
    return data.map((member) => ({
        id: member.id.workspace_member_id,
        name: [member.first_name, member.last_name].filter(Boolean).join(" ") || "Unnamed member",
        avatarUrl: member.avatar_url,
        accessLevel: member.access_level,
    }))
}

/** Returns the member's access level, e.g. "admin", or `null` if no such member exists. */
export async function getWorkspaceMemberAccessLevel(memberId: string): Promise<string | null> {
    return (await getWorkspaceMember(memberId))?.accessLevel ?? null
}

// ---- Querying and updating records ----

const RecordListSchema = z.object({
    data: z.array(
        z.object({
            id: z.object({record_id: z.string()}),
            values: z.record(z.array(z.unknown())),
        })
    ),
})

/** Lists records matching a filter, one page at a time. */
export async function queryRecords({
    objectSlug,
    filter,
    limit = 500,
    offset = 0,
}: {
    objectSlug: string
    filter?: Record<string, unknown>
    limit?: number
    offset?: number
}): Promise<Array<AttioRecord>> {
    const {data} = await attioRequest({
        method: "POST",
        path: `/objects/${encodeURIComponent(objectSlug)}/records/query`,
        body: {filter, limit, offset},
        schema: RecordListSchema,
    })
    return data
}

/**
 * Overwrites the given attributes on a record. An empty array clears an attribute's value.
 * Attributes not included are left unchanged.
 */
export async function putRecordValues({
    objectSlug,
    recordId,
    values,
}: {
    objectSlug: string
    recordId: string
    values: Record<string, unknown>
}): Promise<void> {
    await attioRequest({
        method: "PUT",
        path: `/objects/${encodeURIComponent(objectSlug)}/records/${encodeURIComponent(recordId)}`,
        body: {data: {values}},
        schema: z.unknown(),
    })
}

// ---- Comments (need comment:read-write) ----

/**
 * Posts a plaintext comment on a record. The author must be a workspace member: the API doesn't
 * accept apps as authors. Workspace members are mentioned by including their email address.
 */
export async function createComment({
    objectSlug,
    recordId,
    authorId,
    content,
}: {
    objectSlug: string
    recordId: string
    authorId: string
    content: string
}): Promise<void> {
    await attioRequest({
        method: "POST",
        path: "/comments",
        body: {
            data: {
                format: "plaintext",
                content,
                author: {type: "workspace-member", id: authorId},
                record: {object: objectSlug, record_id: recordId},
            },
        },
        schema: z.unknown(),
    })
}

// ---- Webhooks (need webhook:read-write) ----

export interface WebhookSubscription {
    event_type: string
    filter: Record<string, unknown> | null
}

const CreatedWebhookSchema = z.object({
    data: z.object({id: z.object({webhook_id: z.string()}), secret: z.string()}),
})

export async function createWebhook({
    targetUrl,
    subscriptions,
}: {
    targetUrl: string
    subscriptions: Array<WebhookSubscription>
}): Promise<{webhookId: string; secret: string}> {
    const {data} = await attioRequest({
        method: "POST",
        path: "/webhooks",
        body: {data: {target_url: targetUrl, subscriptions}},
        schema: CreatedWebhookSchema,
    })
    return {webhookId: data.id.webhook_id, secret: data.secret}
}

const WebhookSchema = z.object({data: z.object({status: z.string()})})

/** Returns the webhook's status ("active", "degraded" or "inactive"), or `null` if it's gone. */
export async function getWebhookStatus(webhookId: string): Promise<string | null> {
    try {
        const {data} = await attioRequest({
            method: "GET",
            path: `/webhooks/${encodeURIComponent(webhookId)}`,
            schema: WebhookSchema,
        })
        return data.status
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return null
        }
        throw error
    }
}

export async function deleteWebhook(webhookId: string): Promise<void> {
    try {
        await attioRequest({
            method: "DELETE",
            path: `/webhooks/${encodeURIComponent(webhookId)}`,
            schema: z.unknown(),
        })
    } catch (error) {
        if (error instanceof AttioApiError && error.status === 404) {
            return
        }
        throw error
    }
}
