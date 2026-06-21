/**
 * Storage-channel registry. A channel lets the user push a plan out of the
 * local store into some shareable location. Gist is the only channel today;
 * the registry keeps adding more (S3, Drive, …) a matter of dropping in a
 * module with the same shape.
 *
 * Channel contract:
 *   id, label                         — identity
 *   available() → { ready, ...flags } — can we use it now, and how to fix it
 *   create({markdown, description, filename})              → binding info
 *   update({id, markdown, description, filename, oldFilename}) → binding info
 */
import * as gist from "./gist.js";

export const channels = { [gist.id]: gist };

export function getChannel(id) {
  return channels[id] || null;
}

/** Readiness of every channel, for the picker / verify UI. */
export function listChannelStatus() {
  return Object.values(channels).map((ch) => ({ id: ch.id, label: ch.label, ...ch.available() }));
}
