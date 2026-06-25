// Shared cross-command types for the P0 parity surface.

// Product labels map a command to the Mailgun product entitlement it depends on.
// Used to produce capability-focused 403 guidance in error output.
export type ProductLabel = 'Validate' | 'Optimize' | 'Inspect' | 'Analytics';

// Structured data gap. Emitted when missing upstream data materially affects
// interpretation of a result. `impact` is factual and capability-focused only -
// it must not use risk, severity, or recommended-action language.
export interface DataGap {
  code: string;
  product: ProductLabel;
  message: string;
  impact: string;
}
