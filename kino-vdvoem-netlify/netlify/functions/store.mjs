import { getStore as netlifyStore } from '@netlify/blobs';
import { fileStore } from '../../vps/file-store.mjs';

export const getStore = name => process.env.RAVETYPE_DATA_DIR ? fileStore(name) : netlifyStore(name);
