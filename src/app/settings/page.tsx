import type {
    DecoratedComboboxOption,
    DecoratedComboboxOptionsProvider,
    PlainComboboxOptionsProvider,
} from "attio/client"
import {Settings, TextBlock} from "attio/client"
import {DEFAULT_PRODUCT_MAPPING} from "../../utils/line-item-schema"
import listAttributeOptions from "./list-attribute-options.server"
import type {MemberOption} from "./list-member-options.server"
import listMemberOptions from "./list-member-options.server"
import listObjectOptions from "./list-object-options.server"
import schema from "./schema"

function matches(query: string, option: {label: string; value: string}): boolean {
    const q = query.trim().toLowerCase()
    return !q || option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)
}

/** Shows the member's avatar, or a generic user icon if they don't have one. */
function decorateMember(member: MemberOption): DecoratedComboboxOption {
    const base = {value: member.value, label: member.label, description: member.description}
    return member.avatarUrl ? {...base, avatarUrl: member.avatarUrl} : {...base, icon: "User"}
}

/**
 * Used instead of the built-in user picker, which doesn't show who's currently selected in its
 * list. The stored value is the same: the workspace member's ID.
 */
const memberOptions: DecoratedComboboxOptionsProvider = {
    getOption: async (value) => {
        const member = (await listMemberOptions()).find((m) => m.value === value)
        if (!member) {
            return {label: "Member not found", icon: "User"}
        }
        const {value: _value, ...option} = decorateMember(member)
        return option
    },
    search: async (query) =>
        (await listMemberOptions()).filter((m) => matches(query, m)).map(decorateMember),
}

const objectOptions: PlainComboboxOptionsProvider = {
    getOption: async (value) => {
        const options = await listObjectOptions()
        const option = options.find((o) => o.value === value)
        return option ? {label: option.label, description: option.description} : {label: value}
    },
    search: async (query) => (await listObjectOptions()).filter((o) => matches(query, o)),
}

function attributeOptions({
    objectSlug,
    type,
}: {
    objectSlug: string
    type: "text" | "currency"
}): PlainComboboxOptionsProvider {
    return {
        getOption: async (value) => {
            const options = await listAttributeOptions({objectSlug, type})
            const option = options.find((o) => o.value === value)
            return option
                ? {label: option.label, description: option.description}
                : {label: `${value} (not found)`}
        },
        search: async (query) =>
            (await listAttributeOptions({objectSlug, type})).filter((o) => matches(query, o)),
    }
}

/**
 * Lets an admin point the app at existing Products data, so it never has to create duplicate
 * name or price attributes. Anything left empty uses the default slug.
 */
export default Settings.defineWorkspacePage(schema, () => {
    const {Form, Section, Combobox, WithState, Toggle} = Settings.useForm(schema)

    return (
        <Form>
            <Section title="Products">
                <TextBlock align="left">
                    Choose where your products and their prices live. Line items copy the price when
                    they&apos;re created, so later price changes don&apos;t affect them. Anything
                    left empty uses the default: the {`\`${DEFAULT_PRODUCT_MAPPING.objectSlug}\``}{" "}
                    object, with {`\`${DEFAULT_PRODUCT_MAPPING.nameSlug}\``} and{" "}
                    {`\`${DEFAULT_PRODUCT_MAPPING.priceSlug}\``} attributes. After a change, reopen
                    Add line item to check the setup again.
                </TextBlock>
                <Combobox
                    label="Products object"
                    name="products_object"
                    options={objectOptions}
                    placeholder={`Default: ${DEFAULT_PRODUCT_MAPPING.objectSlug}`}
                />
                <WithState values>
                    {({values}) => {
                        const objectSlug =
                            values.products_object || DEFAULT_PRODUCT_MAPPING.objectSlug
                        return (
                            <>
                                <Combobox
                                    // Remount when the object changes so the options reload.
                                    key={`name-${objectSlug}`}
                                    label="Product name attribute"
                                    name="product_name_attribute"
                                    options={attributeOptions({objectSlug, type: "text"})}
                                    placeholder={`Default: ${DEFAULT_PRODUCT_MAPPING.nameSlug}`}
                                />
                                <Combobox
                                    key={`price-${objectSlug}`}
                                    label="Product price attribute"
                                    name="product_price_attribute"
                                    options={attributeOptions({objectSlug, type: "currency"})}
                                    placeholder={`Default: ${DEFAULT_PRODUCT_MAPPING.priceSlug}`}
                                />
                            </>
                        )
                    }}
                </WithState>
            </Section>
            <Section title="Deal value">
                <TextBlock align="left">
                    When this is on, a deal with at least one line item gets the sum of its line
                    items&apos; Line total as its Deal value. Deals without line items keep the
                    value reps enter. If someone edits Deal value on a deal with line items, or
                    removes its last line item, the app resets or clears the value and explains why
                    in a comment on the deal. Turn off any workflow that also sets Deal value. After
                    turning this on, open Add line item and select Set up automatically to finish
                    setting it up.
                </TextBlock>
                <Toggle label="Calculate deal value from line items" name="deal_value_sync" />
                <Combobox
                    label="Post comments as"
                    name="comment_author"
                    decorated
                    options={memberOptions}
                    placeholder="Choose a member"
                />
            </Section>
        </Form>
    )
})
