import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  contentProps,
}: {
  contentProps?: Omit<ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>, 'children' | 'className'>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="ui-popover-content"
          {...contentProps}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function Dropdown({
  open,
  onOpenChange,
  modal,
  onCloseAutoFocus,
  trigger,
  children,
  align = 'start',
  side = 'bottom',
}: {
  modal?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="ui-menu-content"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function DropdownItem({
  active = false,
  danger = false,
  disabled = false,
  onSelect,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const classes = [
    'ui-menu-item',
    active ? 'ui-menu-item--active' : '',
    danger ? 'ui-menu-item--danger' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <DropdownMenu.Item
      className={classes}
      disabled={disabled}
      onSelect={onSelect}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownMenu.Separator className="ui-menu-separator" />;
}
