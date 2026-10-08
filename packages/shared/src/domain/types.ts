/** Domain entities. Every field except `id` is optional because state is built from field-level patches. Money is integer cents. Dates are ISO `YYYY-MM-DD`. */

export type EntityKind =
  | "child"
  | "paymentMethod"
  | "purchase"
  | "item"
  | "document"
  | "additionalDoc"
  | "submission"
  | "setting"
  | "category";

export interface Child {
  id: string;
  name?: string;
  scholarship?: string;
  /** Per-student cap for the year (base award plus any rollover), in cents. */
  capCents?: number;
  /** Portion of the cap that rolled over from a previous year; informational. */
  rolloverCents?: number;
}

export interface PaymentMethod {
  id: string;
  label?: string;
  kind?: "card" | "cash" | "gift-card" | "other";
  issuer?: string;
  last4?: string[];
  requiresStatement?: boolean;
}

/** One order/receipt. Exactly one receipt document; everything else is additional (see AdditionalDoc). */
export interface Purchase {
  id: string;
  vendor?: string;
  date?: string;
  invoiceNo?: string;
  paymentMethodId?: string;
  receiptDocumentId?: string;
  orderTotalCents?: number;
  taxShippingTotalCents?: number;
  notes?: string;
  /** Hidden from the queue, plan and budget; reversible (the purchase's items are archived with it). */
  archived?: boolean;
}

export interface LineItem {
  id: string;
  purchaseId?: string;
  childId?: string;
  /** Overrides of the purchase's date/invoice/vendor: StepUp takes these per item, and one receipt can cover items with different values. */
  date?: string;
  invoiceNo?: string;
  vendor?: string;
  serviceDate?: string;
  serviceProvider?: string;
  description?: string;
  categoryId?: string;
  categoryPath?: string[];
  quantity?: number;
  amountCents?: number;
  taxShippingCents?: number;
  /** True when taxShippingCents is an estimate rather than a value read from the receipt. */
  taxShippingEstimated?: boolean;
  benefitMessage?: string;
  itemUrl?: string;
  preAuthId?: string;
  submissionId?: string;
  lineNumber?: number;
  /** Status label as observed from StepUp / set by the submission flow (e.g. "Submitted", "Approved", "Paid"). */
  stepUpStatus?: string;
  approvedCents?: number;
  paidCents?: number;
  /** Set by a person or by the submission flow when something outside the data blocks filing (e.g. "needs-split"). Cleared by removing it. */
  hold?: string;
  holdNote?: string;
  /** Human override with a reason; wins over every derived status. */
  statusOverride?: string;
  notes?: string;
  /** Set along with the purchase's `archived`; archived items are ignored by the queue, plan and budget. */
  archived?: boolean;
}

export type ContentKind = "receipt-like" | "statement" | "explanation" | "other";

export interface DocumentRec {
  id: string;
  driveItemId?: string;
  webUrl?: string;
  filename?: string;
  sha256?: string;
  contentKind?: ContentKind;
  sizeBytes?: number;
  pages?: number;
  derivedFrom?: string;
  /** Where it came from: dropped in the year folder the old way, uploaded through the app, or imported from a legacy workbook. */
  source?: "loose" | "upload" | "legacy";
  /** For statements: what was read from the file (see statements/parse.ts). Private; never exported or shared. */
  statement?: StatementData;
  /** Receipt shows payment was made (e.g. "$0.00 owed"); confidence 0..1. */
  paymentEvidenceConfidence?: number;
}

export type AdditionalDocKind = "payment-proof" | "explanation" | "preauth" | "other";

/** Link of a non-receipt document to a purchase or to a single line item. Its id is deterministic so concurrent adds merge. */
export interface AdditionalDoc {
  id: string;
  ownerKind?: "purchase" | "item";
  ownerId?: string;
  documentId?: string;
  kind?: AdditionalDocKind;
  /** For payment proof: which transaction on the statement shows this purchase's charge. */
  transactionId?: string;
  /** 0..1 for an automatic match; a person's own link has none. */
  confidence?: number;
  source?: "auto" | "manual";
}

/** One StepUp reimbursement = one purchase x one child. */
export interface Submission {
  id: string;
  reimbursementId?: string;
  purchaseId?: string;
  childId?: string;
  submittedAt?: string;
}

/** Singleton (id "year") holding year-level configuration. */
export interface YearSettings {
  id: string;
  year?: string;
  /** Annual submission deadline (ISO date); unsubmitted items after it are forfeited. */
  submissionDeadline?: string;
  /** Default tax/shipping estimate rate used until a receipt value is entered (default 0.07). */
  defaultTaxRate?: number;
  mirror?: boolean;
  /** Learned card-descriptor words -> vendor words ("zzq" -> ["amazon"]), so later statements match without asking. */
  vendorAliases?: Record<string, string[]>;
}

/**
 * A year's correction to the shared category tree (plan §3.8 overlay). Keyed by StepUp's category id to change an
 * existing entry, or by a new `user-cat-…` id to add one. Only the fields present override the baseline.
 */
export interface CategoryEdit {
  id: string;
  parentId?: string;
  name?: string;
  isActive?: boolean;
  eligibleScholarships?: string[];
  requiresServiceDate?: boolean;
}

export interface LedgerState {
  children: Record<string, Child>;
  paymentMethods: Record<string, PaymentMethod>;
  purchases: Record<string, Purchase>;
  items: Record<string, LineItem>;
  documents: Record<string, DocumentRec>;
  additionalDocs: Record<string, AdditionalDoc>;
  submissions: Record<string, Submission>;
  settings: Record<string, YearSettings>;
  categories: Record<string, CategoryEdit>;
}

/** A line on a card statement. `amountCents` is positive for a charge and negative for a refund or payment. */
export interface StatementTransaction {
  id: string;
  date: string;
  postDate?: string;
  descriptor: string;
  amountCents: number;
  kind: "purchase" | "credit" | "payment" | "fee";
  /** How sure we are the line was read correctly (0..1); low ones are flagged for a person to check. */
  confidence: number;
}

export interface StatementData {
  issuer?: string;
  last4?: string;
  periodStart?: string;
  periodEnd?: string;
  transactions: StatementTransaction[];
}
