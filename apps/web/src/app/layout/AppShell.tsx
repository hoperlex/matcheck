import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { useListMemoryRecorder } from '../../shared/hooks/useListMemoryRecorder';
import { MobileLayout } from './MobileLayout';
import { DesktopLayout } from './DesktopLayout';

export function AppShell() {
  const bp = useBreakpoint();
  // Память списков пишется здесь, над раскладкой: смена десктоп/мобильной
  // раскладки не должна её прерывать.
  useListMemoryRecorder();
  return bp === 'mobile' ? <MobileLayout /> : <DesktopLayout />;
}
