// «Объекты и вид» у подрядчика (справочник «Контрагенты», миграции 0159, 0160):
// метки в таблице, подсказка с данными 1С и блок правки в карточке.
import { Button, Flex, Form, Select, Space, Tag, Tooltip, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  CONTRACTOR_SITE_KIND_LABELS,
  type ContractorSiteKind,
  type CustomerCounterpartySite,
  type CustomerCounterpartySiteInput,
  type Site,
} from '@matcheck/contracts';

export const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000001';

export const CONTRACTOR_SITE_KIND_COLORS: Record<ContractorSiteKind, string> = {
  realization: 'blue',
  tolling_act: 'orange',
  realization_tolling: 'purple',
  // Ручной вид (0160): подрядчик работает своими материалами — у 1С такого нет.
  contractor_materials: 'green',
};

const KIND_OPTIONS = (Object.keys(CONTRACTOR_SITE_KIND_LABELS) as ContractorSiteKind[]).map(
  (k) => ({
    value: k,
    label: CONTRACTOR_SITE_KIND_LABELS[k],
  }),
);

/** Текст метки и значение фильтра колонки: «Д56 · Реализация». */
export function contractorSiteLabel(
  s: Pick<CustomerCounterpartySite, 'siteCode' | 'kind'>,
): string {
  return `${s.siteCode} · ${CONTRACTOR_SITE_KIND_LABELS[s.kind]}`;
}

function rub(sum: string): string {
  return `${Number(sum).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function dateRu(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU');
}

/** «реализаций 51 на 79 470 451,57 ₽; давальческих актов 8 на …» — нулевые виды и скрытые суммы не пишем. */
export function onecCountsText(onec: NonNullable<CustomerCounterpartySite['onec']>): string {
  const part = (label: string, n: number, sum: string | null) =>
    n > 0 ? `${label} ${n}${sum !== null ? ` на ${rub(sum)}` : ''}` : null;
  return [
    part('реализаций', onec.realizationDocs, onec.realizationSum),
    part('давальческих актов', onec.tollingDocs, onec.tollingSum),
  ]
    .filter(Boolean)
    .join('; ');
}

/** Коротко для карточки и узкого экрана: «51 реал. / 8 дав.», нулевые виды не пишем. */
export function onecShortCounts(onec: NonNullable<CustomerCounterpartySite['onec']>): string {
  return [
    onec.realizationDocs > 0 ? `${onec.realizationDocs} реал.` : null,
    onec.tollingDocs > 0 ? `${onec.tollingDocs} дав.` : null,
  ]
    .filter(Boolean)
    .join(' / ');
}

function SiteTooltip({ s }: { s: CustomerCounterpartySite }) {
  return (
    <Space direction="vertical" size={2}>
      <span>
        <b>{s.siteCode}</b> · {s.siteName}
        {s.siteActive ? '' : ' (объект закрыт)'}
      </span>
      <span>
        Вид: {CONTRACTOR_SITE_KIND_LABELS[s.kind]}
        {s.manual ? ' — указан вручную' : ''}
        {s.manual && s.onec && s.onec.kind !== s.kind
          ? ` (в 1С: ${CONTRACTOR_SITE_KIND_LABELS[s.onec.kind]})`
          : ''}
      </span>
      {s.onec && (
        <span>
          По 1С (загружено {dateRu(s.onec.loadedAt)}): {onecCountsText(s.onec)}
        </span>
      )}
      {s.onec && s.onec.objects.length > 0 && <span>В 1С: {s.onec.objects.join('; ')}</span>}
    </Space>
  );
}

/** Метки колонки «Объекты и вид». */
export function ContractorSiteTags({ sites }: { sites: readonly CustomerCounterpartySite[] }) {
  if (sites.length === 0) return <>—</>;
  return (
    <Space size={[4, 4]} wrap>
      {sites.map((s) => (
        <Tooltip key={s.siteId} title={<SiteTooltip s={s} />}>
          <Tag
            color={CONTRACTOR_SITE_KIND_COLORS[s.kind]}
            style={{ marginInlineEnd: 0, opacity: s.siteActive ? 1 : 0.55 }}
            data-testid="contractor-site-tag"
          >
            {contractorSiteLabel(s)}
            {s.manual ? ' ✎' : ''}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

/** Узкий экран: подсказка по касанию не откроется — числа 1С текстом. */
export function ContractorSitesText({ sites }: { sites: readonly CustomerCounterpartySite[] }) {
  if (sites.length === 0) return null;
  return (
    <Space direction="vertical" size={2}>
      {sites.map((s) => (
        <Typography.Text key={s.siteId} type="secondary">
          {contractorSiteLabel(s)}
          {s.manual ? ' ✎' : ''}
          {s.onec ? ` — по 1С: ${onecShortCounts(s.onec)}` : ''}
        </Typography.Text>
      ))}
    </Space>
  );
}

/** Пары «объект → вид» без учёта порядка; true — список в карточке изменили. */
export function contractorSitesChanged(
  initial: readonly CustomerCounterpartySiteInput[],
  current: readonly Partial<CustomerCounterpartySiteInput>[],
): boolean {
  const key = (s: Partial<CustomerCounterpartySiteInput>) => `${s.siteId ?? ''}:${s.kind ?? ''}`;
  const a = initial.map(key).sort();
  const b = current.map(key).sort();
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
}

export function siteSelectOptions(sites: readonly Site[]) {
  return [...sites]
    .filter((s) => s.id !== SYSTEM_SITE_ID)
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.code.localeCompare(b.code, 'ru'))
    .map((s) => ({
      value: s.id,
      label: `${s.code} · ${s.name}${s.isActive ? '' : ' (закрыт)'}`,
    }));
}

function OnecHint({ onec }: { onec: NonNullable<CustomerCounterpartySite['onec']> | undefined }) {
  if (!onec) return null;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {`по 1С: ${onecShortCounts(onec)} (${CONTRACTOR_SITE_KIND_LABELS[onec.kind]})`}
    </Typography.Text>
  );
}

/** Блок «Объекты и вид» в карточке контрагента (Form.List по полю `sites`). */
export function ContractorSitesFormList({
  form,
  siteOptions,
  sitesLoading,
  onecBySite,
}: {
  form: FormInstance;
  siteOptions: Array<{ value: string; label: string }>;
  sitesLoading: boolean;
  onecBySite: ReadonlyMap<string, NonNullable<CustomerCounterpartySite['onec']>>;
}) {
  // Весь список одним наблюдением: путь вида ['sites', i, 'siteId'] после
  // удаления строки сдвигается, а динамический путь useWatch не поддерживает.
  const watched = Form.useWatch('sites', form) as
    | Array<{ siteId?: string } | undefined>
    | undefined;
  return (
    <Form.Item
      label="Объекты и вид"
      extra="Вид, исправленный здесь, новая загрузка из 1С не перезапишет."
    >
      <Form.List name="sites">
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {fields.map((field) => (
              <div key={field.key}>
                <Flex gap={8} align="start">
                  <Form.Item
                    name={[field.name, 'siteId']}
                    style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
                    rules={[
                      { required: true, message: 'Выберите объект' },
                      {
                        validator: async (_, value: string | undefined) => {
                          if (!value) return;
                          const all = (form.getFieldValue('sites') ?? []) as Array<{
                            siteId?: string;
                          }>;
                          if (all.filter((s) => s?.siteId === value).length > 1)
                            throw new Error('Объект уже есть в списке');
                        },
                      },
                    ]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="Объект"
                      loading={sitesLoading}
                      options={siteOptions}
                      aria-label="Объект"
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'kind']}
                    style={{ width: 210, marginBottom: 0 }}
                    rules={[{ required: true, message: 'Выберите вид' }]}
                  >
                    <Select
                      placeholder="Вид"
                      options={KIND_OPTIONS}
                      aria-label="Вид"
                      // «Реализация + давальческий» шире поля — список не обрезает подпись.
                      popupMatchSelectWidth={false}
                    />
                  </Form.Item>
                  <Button
                    icon={<DeleteOutlined />}
                    aria-label="Убрать объект"
                    onClick={() => remove(field.name)}
                  />
                </Flex>
                <OnecHint onec={onecBySite.get(watched?.[field.name]?.siteId ?? '')} />
              </div>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({})}>
              Объект
            </Button>
          </Space>
        )}
      </Form.List>
    </Form.Item>
  );
}
