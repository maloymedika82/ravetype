import { fileStore } from '../../vps/file-store.mjs';

const netlifyStore = process.env.RAVETYPE_DATA_DIR ? null : (await import('@netlify/blobs')).getStore;
export const getStore = name => process.env.RAVETYPE_DATA_DIR ? fileStore(name) : netlifyStore(name);
