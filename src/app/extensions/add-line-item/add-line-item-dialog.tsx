import {
    Banner,
    Forms,
    LoadingState,
    Section,
    showToast,
    Stack,
    Typography,
    useAsyncCache,
    useForm,
} from "attio/client"
import {Suspense, useMemo, useState} from "react"
import type {ObjectKey} from "../../../utils/line-item-schema"
import {OBJECT_TITLES} from "../../../utils/line-item-schema"
import type {SetupIssue, SetupStatus} from "./check-setup.server"
import checkSetup from "./check-setup.server"
import createLineItem from "./create-line-item.server"
import runSetup from "./run-setup.server"

/**
 * The products object comes from the app's settings. The record picker only lists records from
 * the object set on the schema, so the schema is built per object.
 */
function buildFormSchema(productsObject: string) {
    return {
        product: Forms.attioRecord().object({slug: productsObject}),
        quantity: Forms.number().min(1),
        discountPercent: Forms.number().optional().min(0).max(100),
    }
}

export default function AddLineItemDialog({
    dealId,
    openedAt,
    hideDialog,
}: {
    dealId: string
    /** Changes on every open, so the setup check isn't served from an earlier open's cache. */
    openedAt: number
    hideDialog: () => void
}) {
    return (
        <Suspense fallback={<LoadingState />}>
            <SetupGate dealId={dealId} openedAt={openedAt} hideDialog={hideDialog} />
        </Suspense>
    )
}

/** Shows the form only once the workspace has the objects and attributes the app needs. */
function SetupGate({
    dealId,
    openedAt,
    hideDialog,
}: {
    dealId: string
    openedAt: number
    hideDialog: () => void
}) {
    const {
        values: {setup},
        invalidate,
    } = useAsyncCache({setup: [checkSetup, openedAt]})
    const recheck = () => invalidate("setup")

    if (setup.state === "error") {
        return (
            <Banner
                variant="error"
                size="large"
                title="Couldn't check this workspace's setup"
                actions={[{label: "Try again", variant: "primary", onTrigger: recheck}]}
            >
                {setup.message}
            </Banner>
        )
    }

    if (setup.state === "incomplete") {
        return <SetupGuide status={setup} onRecheck={recheck} />
    }

    return (
        <Stack gap="medium">
            {setup.warnings.length > 0 && <WarningsBanner warnings={setup.warnings} />}
            <LineItemForm
                dealId={dealId}
                productsObject={setup.productsObject}
                hideDialog={hideDialog}
            />
        </Stack>
    )
}

function SetupGuide({
    status,
    onRecheck,
}: {
    status: Extract<SetupStatus, {state: "incomplete"}>
    onRecheck: () => void
}) {
    const [running, setRunning] = useState(false)
    const {issues, warnings, plannedChanges, admin} = status
    const canAutoFix = admin.isAdmin && plannedChanges.length > 0
    // An admin sees automatable changes in the plan, so only list what's left to do by hand.
    const listedIssues = canAutoFix ? issues.filter((issue) => issue.autoFix === null) : issues
    const objectOrder: Array<ObjectKey> = ["products", "lineItems", "deals"]

    const runAutomaticSetup = async () => {
        setRunning(true)
        try {
            const result = await runSetup()
            if (result.ok) {
                await showToast({
                    variant: "success",
                    title: "Setup complete",
                    text: `Made ${result.changes.length} change(s).`,
                })
            } else {
                await showToast({
                    variant: "error",
                    title: "Setup didn't finish",
                    text: result.message,
                    durationMs: 10000,
                })
            }
        } catch (error) {
            console.error("[Add line item] Automatic setup failed", error)
            await showToast({
                variant: "error",
                title: "Setup didn't finish",
                text: "Something went wrong. Check again to see what changed.",
            })
        } finally {
            setRunning(false)
            onRecheck()
        }
    }

    return (
        <Stack gap="large">
            {running ? (
                <Banner variant="neutral" size="large" title="Setting up…">
                    {`Making the ${plannedChanges.length} change(s) listed below. This takes a few seconds.`}
                </Banner>
            ) : canAutoFix ? (
                <Banner
                    variant="warning"
                    size="large"
                    title="Line item setup isn't finished"
                    actions={[
                        {label: "Check again", variant: "secondary", onTrigger: onRecheck},
                        {
                            label: "Set up automatically",
                            variant: "primary",
                            onTrigger: runAutomaticSetup,
                        },
                    ]}
                >
                    You&apos;re an admin, so the app can make the changes listed below for you. No
                    data is deleted: an attribute that needs replacing is renamed and archived, so
                    its data is kept.
                </Banner>
            ) : (
                <Banner
                    variant="warning"
                    size="large"
                    title="Line item setup isn't finished"
                    actions={[{label: "Check again", variant: "primary", onTrigger: onRecheck}]}
                >
                    {plannedChanges.length > 0 ? `${admin.isAdmin ? "" : admin.reason} ` : ""}A
                    workspace admin needs to make the changes below. Then select Check again.
                </Banner>
            )}
            {canAutoFix && (
                <Section title="Set up automatically will">
                    <Stack gap="extraSmall">
                        {plannedChanges.map((change) => (
                            <Typography.Body key={change}>• {change}</Typography.Body>
                        ))}
                    </Stack>
                </Section>
            )}
            {objectOrder.map((object) => {
                const objectIssues = listedIssues.filter((issue) => issue.object === object)
                if (objectIssues.length === 0) {
                    return null
                }
                return (
                    <Section
                        key={object}
                        title={
                            canAutoFix
                                ? `${OBJECT_TITLES[object]}: fix by hand`
                                : OBJECT_TITLES[object]
                        }
                    >
                        <IssueList issues={objectIssues} />
                    </Section>
                )
            })}
            {warnings.length > 0 && (
                <Section title="Optional" description="Line items save without these.">
                    <IssueList issues={warnings} />
                </Section>
            )}
        </Stack>
    )
}

function IssueList({issues}: {issues: Array<SetupIssue>}) {
    return (
        <Stack gap="medium">
            {issues.map((issue) => (
                <Stack key={issue.id} gap="extraSmall">
                    <Typography.Body variant="strong">{issue.problem}</Typography.Body>
                    <Typography.Body>{issue.fix}</Typography.Body>
                </Stack>
            ))}
        </Stack>
    )
}

function WarningsBanner({warnings}: {warnings: Array<SetupIssue>}) {
    return (
        <Banner variant="neutral">
            {warnings.map((warning) => `${warning.problem} ${warning.fix}`).join(" ")}
        </Banner>
    )
}

function LineItemForm({
    dealId,
    productsObject,
    hideDialog,
}: {
    dealId: string
    productsObject: string
    hideDialog: () => void
}) {
    const formSchema = useMemo(() => buildFormSchema(productsObject), [productsObject])
    const {Form, AttioRecordCombobox, NumberInput, SubmitButton} = useForm(formSchema, {
        quantity: 1,
    })

    return (
        <Form
            onSubmit={async (values) => {
                try {
                    const result = await createLineItem({
                        dealId,
                        productId: values.product.recordId,
                        quantity: values.quantity,
                        discountPercent: values.discountPercent ?? null,
                    })
                    if (!result.ok) {
                        await showToast({
                            variant: "error",
                            title: "Line item not added",
                            text: result.message,
                            durationMs: 8000,
                        })
                        return
                    }
                    await showToast({
                        variant: "success",
                        title: "Line item added",
                        text: result.name,
                    })
                    hideDialog()
                } catch (error) {
                    console.error("[Add line item] Unexpected error", error)
                    await showToast({
                        variant: "error",
                        title: "Line item not added",
                        text: "Something went wrong. Try again in a moment.",
                    })
                }
            }}
        >
            <AttioRecordCombobox
                label="Product"
                name="product"
                object={productsObject}
                placeholder="Select a product"
            />
            <NumberInput label="Quantity" name="quantity" />
            <NumberInput label="Discount %" name="discountPercent" placeholder="Optional, 0–100" />
            <SubmitButton label="Add line item" />
        </Form>
    )
}
