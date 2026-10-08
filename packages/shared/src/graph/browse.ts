import { graphJson } from "./client.js";
import { ensureFolder } from "./files.js";
import { resolveShareLink } from "./onedrive.js";

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
  const items = await all(`/drives/${folder.driveId}/items/${folder.itemId}/children?$select=id,name,folder,remoteItem&$top=200`);
  const out: FolderEntry[] = [];
  for (const i of items) {
    // A shortcut ("Add shortcut to My files") is a local stub; the real folder lives on the other person's drive.
    const remote = i.remoteItem;
    if (remote?.folder && remote.parentReference?.driveId) out.push({ driveId: remote.parentReference.driveId, itemId: remote.id, name: i.name });
    else if (i.folder) out.push({ driveId: folder.driveId, itemId: i.id, name: i.name });
  }
  return out.sort(byName);
}

/** Creates (or returns the existing) subfolder. */
export async function createSubfolder(parent: FolderEntry, name: string): Promise<FolderEntry> {
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Folder names cannot be empty or contain \\ / : * ? " < > |');
  return { driveId: parent.driveId, itemId: await ensureFolder(parent.driveId, parent.itemId, clean), name: clean };
}

/**
 * Invites a person (by the email of their Microsoft account) to edit a folder. They must sign in, so the folder is never
 * reachable by link alone. Graph emails them; the folder then appears under "Shared with you".
 */
export async function inviteToFolder(folder: FolderEntry, email: string, message?: string): Promise<void> {
  const address = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("Enter a valid email address.");
  await graphJson(`/drives/${folder.driveId}/items/${folder.itemId}/invite`, {
    method: "POST",
    body: JSON.stringify({ recipients: [{ email: address }], requireSignIn: true, sendInvitation: true, roles: ["write"], ...(message ? { message } : {}) }),
  });
}

/** Resolves a OneDrive sharing link to a folder (works for folders shared with you that Graph's shared list does not show). */
export async function folderFromLink(link: string): Promise<FolderEntry> {
  const ref = await resolveShareLink(link.trim());
  if (!ref.isFolder) throw new Error("That link is to a file. Share a folder link instead.");
  return { driveId: ref.driveId, itemId: ref.itemId, name: ref.name };
}
