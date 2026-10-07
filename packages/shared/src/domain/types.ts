/** Domain entities. Every field except `id` is optional because state is built from field-level patches. Money is integer cents. Dates are ISO `YYYY-MM-DD`. */

export type EntityKind =
  | "child"
  | "paymentMethod"
  | "purchase"
  | "item"
  | "document"
  | "additionalDoc"
  | "submission"
  | "setting";

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
}

export interface LineItem {
  id: string;
  purchaseId?: string;
  childId?: string;
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
  /** Human override with a reason; wins over every derived status. */
  statusOverride?: string;
  notes?: string;
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
  transactionId?: string;
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
}
