import type { DeliveryContext } from "../utils/delivery-context.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

/**
 * Resolve the announce origin by merging `requesterOrigin` (captured at spawn
 * time) with the session entry (persisted delivery context).
 *
 * requesterOrigin takes priority for channel/to/accountId via mergeDeliveryContext.
 * When requesterOrigin is present, session-derived `threadId` and `to` values
 * are only inherited when the requester explicitly carries them. This prevents
 * stale session state (e.g. heartbeat contamination of `lastTo`, or stale
 * thread routing) from leaking into cron and subagent announces.
 */
export function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && !isDeliverableMessageChannel(normalizedRequester.channel)) {
    // Ignore internal/non-deliverable channel hints (for example webchat)
    // so a valid persisted route can still be used for outbound delivery.
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  // requesterOrigin (captured at spawn time) reflects the channel the user is
  // actually on and must take priority over the session entry, which may carry
  // stale lastChannel / lastTo values from a previous channel interaction.
  const merged = mergeDeliveryContext(normalizedRequester, normalizedEntry);
  if (!merged) {
    return undefined;
  }
  // When a requesterOrigin is present, only keep session-derived `threadId`
  // and `to` if the requester explicitly carried them. Session-stored values
  // may be stale (e.g. heartbeat overwrites `lastTo` with its own target
  // channel, causing cron announces to route to the wrong destination).
  if (normalizedRequester) {
    const cleanThreadId = normalizedRequester.threadId != null ? merged.threadId : undefined;
    const cleanTo = normalizedRequester.to != null ? merged.to : undefined;
    if (cleanThreadId !== merged.threadId || cleanTo !== merged.to) {
      return normalizeDeliveryContext({
        channel: merged.channel,
        to: cleanTo,
        accountId: merged.accountId,
        threadId: cleanThreadId,
      });
    }
  }
  return merged;
}
