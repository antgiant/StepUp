import { setTokenProvider } from "../graph/client.js";
import { subfolders, inviteToFolder, folderFromLink, myDriveRoot, sharedFolders } from "../graph/browse.js";
import { GraphError, graphJson } from "../graph/client.js";
import { deleteItem, ensureFolder, findChild, readTextFile, renameItem, writeFile } from "../graph/files.js";
import { fetchItemContent } from "../graph/onedrive.js";
import type { AppFolder, FileBody, FolderEntry, StorageAuth, StorageEntry, StorageProvider, StoredFile, WriteOptions } from "./types.js";

/** Sign-in for OneDrive: the usual account operations plus the access token Microsoft Graph needs. Each host (browser, command line) supplies its own. */
export interface OneDriveAuth extends StorageAuth {
  getToken(): Promise<string>;
}

interface ItemJson {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  folder?: unknown;
  lastModifiedDateTime?: string;
  parentReference?: { id?: string; driveId?: string };
}

interface Page {
  value: ItemJson[];
  "@odata.nextLink"?: string;
}

const SELECT = "id,name,size,eTag,webUrl,folder,lastModifiedDateTime";

const entry = (i: ItemJson): StorageEntry => ({
  id: i.id,
  name: i.name,
  isFolder: Boolean(i.folder),
  ...(i.size !== undefined ? { size: i.size } : {}),
  ...(i.eTag ? { eTag: i.eTag } : {}),
  ...(i.webUrl ? { webUrl: i.webUrl } : {}),
  ...(i.lastModifiedDateTime ? { modified: i.lastModifiedDateTime } : {}),
});

/** The person's OneDrive (personal or business), through Microsoft Graph. Sign-in comes from `setTokenProvider`. */
export class OneDriveProvider implements StorageProvider {
  readonly kind = "onedrive" as const;
  readonly label = "OneDrive";

  /** Signing in is part of choosing OneDrive: the Graph client takes its tokens from this provider's auth. */
  constructor(readonly auth: OneDriveAuth) {
    setTokenProvider(() => auth.getToken());
  }

  async list(driveId: string, folderId: string): Promise<StorageEntry[]> {
    const out: StorageEntry[] = [];
    let url: string | undefined = `/drives/${driveId}/items/${folderId}/children?$select=${SELECT}&$top=200`;
    while (url) {
      const page: Page = await graphJson<Page>(url);
      out.push(...page.value.map(entry));
      url = page["@odata.nextLink"];
    }
    return out;
  }

  async find(driveId: string, parentId: string, name: string): Promise<StorageEntry | undefined> {
    const found = await findChild(driveId, parentId, name);
    return found ? { id: found.id, name: found.name, isFolder: found.isFolder, size: found.size, eTag: found.eTag, webUrl: found.webUrl } : undefined;
  }

  async stat(driveId: string, itemId: string): Promise<StorageEntry> {
    return entry(await graphJson<ItemJson>(`/drives/${driveId}/items/${itemId}?$select=${SELECT}`));
  }

  async parentOf(driveId: string, itemId: string): Promise<string> {
    const item = await graphJson<ItemJson>(`/drives/${driveId}/items/${itemId}?$select=parentReference`);
    const id = item.parentReference?.id;
    if (!id) throw new Error("Item has no parent folder");
    return id;
  }

  readText(driveId: string, itemId: string): Promise<{ text: string; eTag?: string }> {
    return readTextFile(driveId, itemId);
  }

  async download(driveId: string, itemId: string, label?: string): Promise<Blob> {
    return (await fetchItemContent(driveId, itemId, label)).blob();
  }

  ensureFolder(driveId: string, parentId: string, name: string): Promise<string> {
    return ensureFolder(driveId, parentId, name);
  }

  write(driveId: string, parentId: string, name: string, body: FileBody, options: WriteOptions = {}): Promise<StoredFile> {
    return writeFile(driveId, parentId, name, body, options);
  }

  async rename(driveId: string, itemId: string, name: string): Promise<string> {
    await renameItem(driveId, itemId, name);
    return itemId; // OneDrive ids survive a rename
  }

  remove(driveId: string, itemId: string, ifMatch?: string): Promise<void> {
    return deleteItem(driveId, itemId, ifMatch);
  }

  async appFolder(): Promise<AppFolder | undefined> {
    try {
      const item = await graphJson<ItemJson>("/me/drive/special/approot?$select=id,parentReference");
      return item.parentReference?.driveId ? { driveId: item.parentReference.driveId, id: item.id } : undefined;
    } catch (err) {
      if (err instanceof GraphError && (err.status === 404 || err.status === 403)) return undefined;
      throw err;
    }
  }

  home(): Promise<FolderEntry> {
    return myDriveRoot();
  }

  sharedWithMe(): Promise<FolderEntry[]> {
    return sharedFolders();
  }

  subfolders(folder: FolderEntry): Promise<FolderEntry[]> {
    return subfolders(folder);
  }

  folderFromLink(link: string): Promise<FolderEntry> {
    return folderFromLink(link);
  }

  invite(folder: FolderEntry, email: string, message?: string): Promise<void> {
    return inviteToFolder(folder, email, message);
  }
}
