import type { ReactNode } from 'react';
import type { SourceDocument } from '@matcheck/contracts';
import { ExpectedSourceDocsList } from '../shared/ExpectedSourceDocsList';
import type { PageTabItem } from '../../shared/ui/PageTabs';

export function ExpectedUpds({
  onOpen,
  tabs,
  activeTab,
  onTabChange,
  filtersExtra,
}: {
  onOpen: (upd: SourceDocument) => void;
  tabs?: PageTabItem[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  filtersExtra?: ReactNode;
}) {
  return (
    <ExpectedSourceDocsList
      direction="inbound"
      onOpen={onOpen}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={onTabChange}
      filtersExtra={filtersExtra}
    />
  );
}
