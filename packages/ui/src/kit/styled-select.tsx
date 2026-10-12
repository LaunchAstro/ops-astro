// SPDX-License-Identifier: AGPL-3.0-only
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { SelectControl, type Option } from './controls-fields.tsx';

type StyledSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onFocus'> & {
  /** Runs when the visible control is focused or clicked, for lists read on first use. */
  readonly onFocus?: (() => void) | undefined;
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
  useEffect(() => {
    const page = native.current?.ownerDocument;
    if (!page) return;
    // A reset restores the select after its event, without a render or change event.
    // The page hears it on the way down, from whichever form owns the select
    // now, so a handler on the form that stops it bubbling cannot hide it.
    const reset = (event: Event): void => {
      if (event.target !== native.current?.form) return;
      setTimeout(() => setValue(native.current?.value ?? ''));
    };
    page.addEventListener('reset', reset, true);
    return () => page.removeEventListener('reset', reset, true);
  }, []);
  const choose = (next: string): void => {
    if (native.current === null || next === native.current.value) return;
    native.current.value = next;
    native.current.dispatchEvent(new Event('change', { bubbles: true }));
    if (props.value === undefined) setValue(next);
  };
  return { native, options, label, value, choose };
}

/** Keeps native form/change semantics while sharing the kit's custom option menu. */
export function StyledSelect(props: StyledSelectProps): ReactElement {
  const generated = useId();
  const { leading, optionLeading, onFocus, ...nativeProps } = props;
  const { native, options, label, value, choose } = useNativeSelect(props);
  // Clicking a button does not focus it in every browser, so a click counts as focus too.
  const used = (event: { readonly target: EventTarget }): void => {
    if (event.target !== native.current) onFocus?.();
  };
  return (
    <div className="styled-select" onFocus={used} onClick={used}>
      <select
        {...nativeProps}
        ref={native}
        className={`sel__native ${props.className ?? ''}`}
        aria-hidden="true"
        tabIndex={-1}
        onFocus={() => {
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
