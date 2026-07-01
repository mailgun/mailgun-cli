// Shared cross-command types used across the CLI command surface.

// Product labels map a command to the Mailgun product entitlement it depends on.
// When a command wraps one API endpoint, use the source OpenAPI spec as the
// product boundary. Used to produce capability-focused 403 guidance in errors.
export type ProductLabel = 'Send' | 'Optimize' | 'Validate' | 'Inspect';

// Structured data gap. Emitted when missing upstream data materially affects
// interpretation of a result. `impact` is factual and capability-focused only -
// it must not use risk, severity, or recommended-action language.
export interface DataGap {
  code: string;
  product: ProductLabel;
  message: string;
  impact: string;
}
