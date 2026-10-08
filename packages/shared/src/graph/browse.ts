import { graphJson } from "./client.js";
import { ensureFolder } from "./files.js";

/** A folder a person can pick: enough to address it on any drive (including one shared with them). */
export interface FolderEntry {
  driveId: string;
  itemId: string;
  name: string;
}

interface Item {
  id: string;
  name: string;
  folder?: unknown;
  parentReference?: { driveId?: string };
  remoteItem?: Item;
}

interface Page {
  value: Item[];
  "@odata.nextLink"?: string;
}

async function all(url: string): Promise<Item[]> {
  const out: Item[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: Page = await graphJson<Page>(next);
    out.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return out;
}

const byName = (a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name);

/** The signed-in person's own OneDrive root. */
export async function myDriveRoot(): Promise<FolderEntry> {
  const root = await graphJson<Item>("/me/drive/root?$select=id,name,parentReference");
  return { driveId: root.parentReference?.driveId ?? "", itemId: root.id, name: "My OneDrive" };
}

/** Folders other people have shared with the signed-in person. */
export async function sharedFolders(): Promise<FolderEntry[]> {
  const items = await all("/me/drive/sharedWithMe?$top=200");
  const out: FolderEntry[] = [];
  for (const i of items) {
    const r = i.remoteItem ?? i;
    const driveId = r.parentReference?.driveId;
    if (r.folder && driveId) out.push({ driveId, itemId: r.id, name: r.name });
  }
  return out.sort(byName);
}

/** Subfolders only (files are not shown in the picker). */
export async function subfolders(folder: FolderEntry): Promise<FolderEntry[]> {
  const items = await all(`/drives/${folder.driveId}/items/${folder.itemId}/children?$select=id,name,folder&$top=200`);
  return items.filter((i) => i.folder).map((i) => ({ driveId: folder.driveId, itemId: i.id, name: i.name })).sort(byName);
}

/** Creates (or returns the existing) subfolder. */
export async function createSubfolder(parent: FolderEntry, name: string): Promise<FolderEntry> {
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Folder names cannot be empty or contain \\ / : * ? " < > |');
  return { driveId: parent.driveId, itemId: await ensureFolder(parent.driveId, parent.itemId, clean), name: clean };
}
