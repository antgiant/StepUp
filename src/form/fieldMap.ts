export interface ColumnFieldMapping {
  selector: string;
  source: "column";
  column: string;
  type?: "text" | "select" | "checkbox" | "radio";
}

export interface FixedFieldMapping {
  selector: string;
  source: "fixed";
  value: string | boolean;
  type?: "text" | "select" | "checkbox" | "radio";
}

export interface FileFieldMapping {
  selector: string;
  source: "file";
  /** Substring to search for in the reference-files folder, e.g. "birth certificate". */
  fileQuery: string;
}

export type FieldMapping = ColumnFieldMapping | FixedFieldMapping | FileFieldMapping;

export interface PageMapping {
  /** Human-readable name shown in prompts, e.g. "Student Information". */
  name: string;
  fields: FieldMapping[];
}

export interface FormConfig {
  /** Name of the Excel Table (not worksheet) holding applicant rows — see discover script output. */
  tableName: string;
  /** Table column used to look up the applicant's row, e.g. "Student Full Name". */
  matchColumn: string;
  /** Optional column to write a status/date back to once you confirm submission. Omit to skip write-back. */
  statusColumn?: string;
  pages: PageMapping[];
}
