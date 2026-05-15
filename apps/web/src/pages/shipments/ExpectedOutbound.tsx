import type { SourceDocument } from '@matcheck/contracts';
import { ExpectedSourceDocsList } from '../shared/ExpectedSourceDocsList';

export function ExpectedOutbound({ onOpen }: { onOpen: (upd: SourceDocument) => void }) {
  return <ExpectedSourceDocsList direction="outbound" onOpen={onOpen} />;
}
