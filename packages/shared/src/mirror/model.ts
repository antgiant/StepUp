export type ColFormat = "text" | "date" | "currency" | "int";

export interface MirrorCell {
  /** Plain value; dates are ISO strings and are converted by the writer when the column format is `date`. */
  v?: string | number | boolean | null;
  /** Native cell hyperlink target (never a HYPERLINK() formula). */
  link?: string;
  fill?: string;
  bold?: boolean;
}

export interface MirrorColumn {
  header: string;
  width: number;
  format?: ColFormat;
}

export interface MirrorSheet {
  name: string;
  columns: MirrorColumn[];
  rows: MirrorCell[][];
  autoFilter?: boolean;
}

export interface MirrorWorkbook {
  sheets: MirrorSheet[];
  /** Hash of the ledger state this was built from; lets writers skip identical regenerations. */
  stateHash: string;
}
