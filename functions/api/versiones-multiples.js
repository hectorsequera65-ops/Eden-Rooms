import { handleVersionSnapshot } from '../../lib/version-snapshots.js';

export async function onRequestPost(context) {
  return handleVersionSnapshot(context);
}
