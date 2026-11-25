import "react";

// The Polaris web components loaded by the embedded layout (polaris-2.js), typed loosely: one declaration shared by
// every embedded page, since a tag declared twice with different props is a type error.
type PolarisProps = React.HTMLAttributes<HTMLElement> &
  React.Attributes & {
    heading?: string;
    tone?: string;
    variant?: string;
    size?: string;
    direction?: string;
    gap?: string;
    alignItems?: string;
    justifyContent?: string;
    padding?: string;
    disabled?: boolean;
    readOnly?: boolean;
    label?: string;
    value?: string;
    placeholder?: string;
    type?: string;
    maxLength?: number;
    min?: number;
    max?: number;
    rows?: number;
    checked?: boolean;
    details?: string;
    error?: string;
  };

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": PolarisProps;
      "s-section": PolarisProps;
      "s-stack": PolarisProps;
      "s-box": PolarisProps;
      "s-heading": PolarisProps;
      "s-paragraph": PolarisProps;
      "s-text": PolarisProps;
      "s-badge": PolarisProps;
      "s-banner": PolarisProps;
      "s-button": PolarisProps;
      "s-divider": PolarisProps;
      "s-text-field": PolarisProps;
      "s-text-area": PolarisProps;
      "s-select": PolarisProps;
      "s-option": PolarisProps;
      "s-checkbox": PolarisProps;
      "s-unordered-list": PolarisProps;
      "s-list-item": PolarisProps;
    }
  }
}
