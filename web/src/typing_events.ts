import $ from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import render_editing_notifications from "../templates/editing_notifications.hbs";
import render_typing_notifications from "../templates/typing_notifications.hbs";

import * as message_lists from "./message_lists.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import {current_user, realm} from "./state_data.ts";
import * as typing_data from "./typing_data.ts";

// See docs/subsystems/typing-indicators.md for details on typing indicators.

// This code handles the inbound side of typing notifications.
// When another user is typing, we process the events here.
//
// We also handle the local event of re-narrowing.
// (For the outbound code, see typing.ts.)

// If number of users typing exceed this,
// we render "Several people are typing..."
const MAX_USERS_TO_DISPLAY_NAME = 3;

// Note!: There are also timing constants in typing_status.ts
// that make typing indicators work.

export const typing_user_schema = z.object({
    email: z.string(),
    user_id: z.number(),
});

export const typing_event_schema = z.intersection(
    z.object({
        id: z.number(),
        op: z.enum(["start", "stop"]),
        type: z.literal("typing"),
        // Optional extensions are ignored by older clients, preserving normal
        // typing indicators when a sender does not include progress text.
        progress_text: z.optional(z.string()),
        turn_id: z.optional(z.string()),
    }),
    z.discriminatedUnion("message_type", [
        z.object({
            message_type: z.literal("stream"),
            sender: typing_user_schema,
            stream_id: z.number(),
            topic: z.string(),
        }),
        z.object({
            message_type: z.literal("direct"),
            recipients: z.array(typing_user_schema),
            sender: typing_user_schema,
        }),
    ]),
);
type TypingEvent = z.output<typeof typing_event_schema>;

export const typing_edit_message_event_schema = z.object({
    message_id: z.number(),
    op: z.enum(["start", "stop"]),
    type: z.literal("typing_edit_message"),
    sender_id: z.number(),
    recipient: z.discriminatedUnion("type", [
        z.object({
            type: z.literal("channel"),
            channel_id: z.number(),
            topic: z.string(),
        }),
        z.object({
            type: z.literal("direct"),
            user_ids: z.array(z.number()),
        }),
    ]),
});

type TypingMessageEditEvent = z.output<typeof typing_edit_message_event_schema>;

function get_users_typing_for_narrow(): number[] {
    if (narrow_state.narrowed_by_topic_reply()) {
        const current_stream_id = narrow_state.stream_id(narrow_state.filter(), true);
        const current_topic = narrow_state.topic();
        if (current_stream_id === undefined) {
            // Narrowed to a channel which doesn't exist.
            return [];
        }
        assert(current_topic !== undefined);
        return typing_data.get_topic_typists(current_stream_id, current_topic);
    }

    if (!narrow_state.narrowed_to_pms()) {
        // Narrow is neither "dm:" nor "is:dm" nor topic.
        return [];
    }

    // Narrow has a filter with either "dm:" or "is:dm".
    const current_filter = narrow_state.filter()!;
    if (current_filter.has_operator("dm")) {
        // Get list of users typing in this conversation
        const narrow_user_ids = current_filter.terms_with_operator("dm")[0]!.operand;
        if (!people.is_valid_bulk_user_ids_for_compose(narrow_user_ids, true)) {
            // Narrowed to an invalid direct message recipient.
            return [];
        }
        const group = [...narrow_user_ids, current_user.user_id];
        return typing_data.get_group_typists(group);
    }
    // Get all users typing (in all direct message conversations with current user)
    return typing_data.get_all_direct_message_typists();
}

function get_typing_key_for_narrow(): string | undefined {
    if (narrow_state.narrowed_by_topic_reply()) {
        const stream_id = narrow_state.stream_id(narrow_state.filter(), true);
        const topic = narrow_state.topic();
        if (stream_id !== undefined && topic !== undefined) {
            return typing_data.get_topic_key(stream_id, topic);
        }
        return undefined;
    }

    const current_filter = narrow_state.filter();
    if (current_filter?.has_operator("dm")) {
        const recipient_ids = current_filter.terms_with_operator("dm")[0]!.operand;
        if (people.is_valid_bulk_user_ids_for_compose(recipient_ids, true)) {
            return typing_data.get_direct_message_conversation_key([
                ...recipient_ids,
                current_user.user_id,
            ]);
        }
    }
    return undefined;
}

export function render_notifications_for_narrow(): void {
    const user_ids = get_users_typing_for_narrow();
    const typing_key = get_typing_key_for_narrow();
    const users_typing = user_ids
        .map((user_id) => people.get_user_by_id_assert_valid(user_id))
        .filter((person) => !person.is_inaccessible_user)
        .map((person) => {
            const typing_progress = typing_key
                ? typing_data.get_typist_progress(typing_key, person.user_id)?.progress_text
                : undefined;
            return typing_progress === undefined ? person : {...person, typing_progress};
        });
    const num_of_users_typing = users_typing.length;

    if (num_of_users_typing === 0) {
        $("#typing_notifications").hide();
    } else {
        $("#typing_notifications").html(
            render_typing_notifications({
                users: users_typing,
                several_users: num_of_users_typing > MAX_USERS_TO_DISPLAY_NAME,
            }),
        );
        $("#typing_notifications").show();
    }
}

function apply_message_edit_notifications($row: JQuery, is_typing: boolean): void {
    const $editing_notifications = $row.find(".edit-notifications");
    if (is_typing) {
        $row.find(".message_edit_notice").addClass("hide");
        $editing_notifications.html(render_editing_notifications());
    } else {
        $row.find(".message_edit_notice").removeClass("hide");
        $editing_notifications.html("");
    }
}

export function render_message_editing_typing(message_id: number, is_typing: boolean): void {
    const $row = message_lists.current?.get_row(message_id);
    if ($row !== undefined) {
        apply_message_edit_notifications($row, is_typing);
    }
}

function get_key(event: TypingEvent): string {
    if (event.message_type === "stream") {
        return typing_data.get_topic_key(event.stream_id, event.topic);
    }
    if (event.message_type === "direct") {
        const recipients = event.recipients.map((user) => user.user_id);
        recipients.sort();
        return typing_data.get_direct_message_conversation_key(recipients);
    }
    throw new Error("Invalid typing notification type", event);
}

export function hide_notification(event: TypingEvent): void {
    const key = get_key(event);
    const active_turn_id = typing_data.get_typist_progress(key, event.sender.user_id)?.turn_id;
    // A delayed stop from an older agent turn must not clear a newer turn's
    // progress. Ordinary typing stops have no turn_id and retain stock Zulip
    // behaviour.
    if (
        event.turn_id !== undefined &&
        active_turn_id !== undefined &&
        event.turn_id !== active_turn_id
    ) {
        return;
    }
    typing_data.clear_inbound_timer(key);

    const removed = typing_data.remove_typist(key, event.sender.user_id);

    if (removed) {
        render_notifications_for_narrow();
    }
}

export function hide_message_edit_notification(event: TypingMessageEditEvent): void {
    const message_id = event.message_id;
    const key = JSON.stringify(message_id);
    typing_data.clear_inbound_timer(key);
    const removed = typing_data.remove_edit_message_typing_id(message_id);
    if (removed) {
        render_message_editing_typing(message_id, false);
    }
}

export function display_notification(event: TypingEvent): void {
    const sender_id = event.sender.user_id;

    const key = get_key(event);
    typing_data.add_typist(key, sender_id);
    // A start without text replaces any prior status, just like a stop or expiry.
    typing_data.set_typist_progress(key, sender_id, event.progress_text, event.turn_id);

    render_notifications_for_narrow();

    typing_data.kickstart_inbound_timer(
        key,
        realm.server_typing_started_expiry_period_milliseconds,
        () => {
            hide_notification(event);
        },
    );
}

export function display_message_edit_notification(event: TypingMessageEditEvent): void {
    const message_id = event.message_id;
    const key = JSON.stringify(message_id);
    typing_data.add_edit_message_typing_id(message_id);
    render_message_editing_typing(message_id, true);
    typing_data.kickstart_inbound_timer(
        key,
        realm.server_typing_started_expiry_period_milliseconds,
        () => {
            hide_message_edit_notification(event);
        },
    );
}

export function disable_typing_notification(): void {
    typing_data.clear_typing_data();
    render_notifications_for_narrow();
}
