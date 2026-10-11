// SPDX-License-Identifier: AGPL-3.0-only
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { SelectControl, type Option } from '../kit/controls-fields.tsx';

type StyledSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  readonly leading?: ReactNode;
  readonly optionLeading?: (value: string) => ReactNode;
};

function useNativeSelect(props: StyledSelectProps) {
  const native = useRef<HTMLSelectElement>(null);
  const [options, setOptions] = useState<readonly Option[]>([]);
  const [label, setLabel] = useState(props['aria-label'] ?? '');
  const [value, setValue] = useState(String(props.value ?? props.defaultValue ?? ''));
  useLayoutEffect(() => {
    const element = native.current;
    if (element === null) return;
    const next = [...element.options].map((option) => ({
      value: option.value,
      label: option.label,
      disabled:
        option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    }));
    setOptions((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
    setValue(element.value);
    setLabel(
      props['aria-label'] ??
        [...(element.labels ?? [])]
          .map((item) => item.textContent)
          .join(' ')
          .trim(),
    );
  });
  const choose = (next: string): void => {
    if (native.current === null) return;
    native.current.value = next;
    native.current.dispatchEvent(new Event('change', { bubbles: true }));
    if (props.value === undefined) setValue(next);
  };
  return { native, options, label, value, choose };
}

/** Keeps native form/change semantics while sharing the kit's custom option menu. */
export function StyledSelect(props: StyledSelectProps): ReactElement {
  const generated = useId();
  const { leading, optionLeading, ...nativeProps } = props;
  const { native, options, label, value, choose } = useNativeSelect(props);
  return (
    <div className="styled-select">
      <select
        {...nativeProps}
        ref={native}
        className={`sel__native ${props.className ?? ''}`}
        aria-hidden="true"
        tabIndex={-1}
        onFocus={(event) => {
          props.onFocus?.(event);
          native.current?.parentElement?.querySelector('button')?.focus();
        }}
      />
      <SelectControl
        id={`${props.id ?? generated}-control`}
        label={label}
        options={options}
        value={String(props.value ?? value)}
        disabled={props.disabled}
        onChange={choose}
        leading={leading}
        optionLeading={optionLeading}
      />
    </div>
  );
}
