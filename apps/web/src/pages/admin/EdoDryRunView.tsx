import { Alert, Card, Collapse, Space, Tag, Typography } from 'antd';
import type { EdoDryRunDocument, EdoDryRunReport } from '@matcheck/contracts';
import { formatDateRu, formatDateTimeRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { acceptedCount, contentSummary, contentTone, itemKindLabel } from './edo-dry-run-view';

/**
 * Отчёт пробного разбора: что вычитано из настоящих документов ящика.
 *
 * Показывает и взятое, и отсеянное — с причиной у каждого документа, — а под
 * спойлерами сырьё для разбора неполадок: что сообщил сам Диадок, как устроен
 * XML и чего в документе не хватает до карточки.
 */
export function EdoDryRunView({ report }: { report: EdoDryRunReport }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text strong>
        Пробный разбор: найдено УПД-кандидатов {report.candidates}, скачано {report.examined}, в
        карточки прошли бы {acceptedCount(report)}
      </Typography.Text>

      {report.interrupted === 'deadline' && (
        <Alert
          type="warning"
          showIcon
          message="Прервано по времени"
          description="Разбор уложился в предел 150 секунд не целиком: показано то, что успели скачать. Возьмите период короче или повторите."
        />
      )}

      {report.selection.byMeta.length > 0 && (
        <Space size={[4, 4]} wrap>
          <Typography.Text type="secondary">Отбор по типу:</Typography.Text>
          {report.selection.byMeta.map((c) => (
            <Tag key={c.category} color={c.category === 'utd_candidate' ? 'blue' : undefined}>
              {c.label}: {c.count}
            </Tag>
          ))}
        </Space>
      )}
      <Typography.Text type="secondary">{contentSummary(report)}</Typography.Text>

      {report.candidates === 0 && (
        <Typography.Text type="secondary">
          {report.truncated
            ? `В первых ${report.eventsSeen} событиях УПД-кандидатов не встретилось — это не весь ящик.`
            : 'За период УПД-кандидатов не встретилось — разбирать нечего.'}
        </Typography.Text>
      )}

      {report.documents.map((d) => (
        <DocumentCard key={d.entityId} doc={d} />
      ))}

      {report.scans.length > 0 && (
        <>
          <Typography.Text strong>Сканы без типа — только метаданные, не скачивались</Typography.Text>
          {report.scans.map((s) => (
            <Card key={s.entityId} size="small">
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Typography.Text>
                  {s.meta.fileName ?? '(без имени)'} · {s.meta.documentNumber ?? 'без номера'}
                  {s.meta.documentDate ? ` от ${s.meta.documentDate}` : ''}
                </Typography.Text>
                <Typography.Text type="secondary">{s.reason}</Typography.Text>
                <Collapse
                  size="small"
                  items={[
                    {
                      key: 'diadoc',
                      label: `Что сообщает Диадок (${s.diadocFields.length})`,
                      children: <FieldList fields={s.diadocFields} />,
                    },
                  ]}
                />
              </Space>
            </Card>
          ))}
        </>
      )}
    </Space>
  );
}

function DocumentCard({ doc: d }: { doc: EdoDryRunDocument }) {
  const p = d.parsed;
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <Tag color={contentTone(d.content?.category ?? null)}>
            {d.content?.label ?? 'не прочитан'}
          </Tag>
          {d.accepted ? (
            <Tag color="green">попал бы в документы</Tag>
          ) : (
            <Tag color="red">не прошёл бы</Tag>
          )}
          <Typography.Text>
            {p?.docNumber || d.meta.documentNumber || '(без номера)'} от{' '}
            {p?.docDate ? formatDateRu(p.docDate) : d.meta.documentDate || '—'}
          </Typography.Text>
        </Space>
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {[d.meta.typeNamedId, d.meta.function, d.meta.version, p?.formatVersion && `формат ${p.formatVersion}`]
            .filter(Boolean)
            .join(' · ')}
          {d.sizeBytes !== null ? ` · ${Math.round(d.sizeBytes / 1024)} КБ` : ''}
          {d.meta.receivedAt
            ? ` · доставлен ${formatDateTimeRu(d.meta.receivedAt)}${
                d.meta.receivedAtSource === 'message' ? ' (время сообщения)' : ''
              }`
            : ' · время доставки неизвестно'}
        </Typography.Text>
        {d.content && <Typography.Text type="secondary">Отбор: {d.content.reason}</Typography.Text>}

        {p && (
          <>
            {p.correction && (
              <Typography.Text>
                Исправление № {p.correction.number ?? '—'} от {formatDateRu(p.correction.date)}
              </Typography.Text>
            )}
            <Typography.Text>
              Продавец: {p.suppliers.map((s) => `${s.name} (ИНН ${s.inn}${s.kpp ? `, КПП ${s.kpp}` : ''})`).join('; ')}
            </Typography.Text>
            <Typography.Text>
              Покупатель: {p.buyers.length ? p.buyers.map((b) => `${b.name} (ИНН ${b.inn})`).join('; ') : '—'}
            </Typography.Text>
            <Typography.Text>
              Грузополучатель:{' '}
              {p.consignee
                ? [p.consignee.name, p.consignee.inn && `ИНН ${p.consignee.inn}`, p.consignee.address]
                    .filter(Boolean)
                    .join(', ')
                : '—'}
              {p.consignorSameAsSeller ? ' · грузоотправитель — он же' : ''}
            </Typography.Text>
            {p.transfer && (
              <Typography.Text>
                Отгрузка: {formatDateRu(p.transfer.date)}
                {p.transfer.operation ? ` · ${p.transfer.operation}` : ''}
                {p.transfer.basis.length
                  ? ` · основание: ${p.transfer.basis
                      .map((b) => [b.name, b.number && `№ ${b.number}`, b.date && `от ${formatDateRu(b.date)}`].filter(Boolean).join(' '))
                      .join('; ')}`
                  : ''}
              </Typography.Text>
            )}
            {p.shippingDocs.length > 0 && (
              <Typography.Text>
                Документы об отгрузке:{' '}
                {p.shippingDocs
                  .map((s) => [s.name, s.number && `№ ${s.number}`, s.date && `от ${formatDateRu(s.date)}`].filter(Boolean).join(' '))
                  .join('; ')}
              </Typography.Text>
            )}
            <Typography.Text>
              Позиций: {p.itemsCount} · итого с НДС: {formatMoneyRu(p.totalSum)} · без НДС:{' '}
              {formatMoneyRu(p.totalExVat)} · НДС: {formatMoneyRu(p.vatSum)}
            </Typography.Text>
            {p.sampleItems.map((i) => (
              <Typography.Text key={i.lineNo} type="secondary">
                {i.lineNo}. {i.name} — {i.qty} {i.unit} × {formatMoneyRu(i.price)} = {formatMoneyRu(i.sum)} с НДС
                {i.vatRate !== null ? ` (НДС ${i.vatRate}%)` : ''} · {itemKindLabel(i.kind)}
                {i.productCode ? ` · код ${i.productCode}` : ''}
              </Typography.Text>
            ))}
          </>
        )}

        {d.supplierHistory && (
          <Typography.Text type="secondary">
            В портале: {d.supplierHistory.deliveries > 0
              ? `поставщик привозил материалы — приёмок ${d.supplierHistory.deliveries}, последняя ${formatDateRu(d.supplierHistory.lastAt)}`
              : 'приёмок с документами этого поставщика нет'}
          </Typography.Text>
        )}

        {d.reasons.length > 0 && (
          <Alert type="warning" showIcon message="Почему не прошёл" description={d.reasons.join('; ')} />
        )}
        {/*
          Расхождение с метаданными — самый ранний признак того, что парсер
          читает не те поля: провайдер знает номер и дату независимо от
          содержимого.
        */}
        {d.mismatches.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="Разбор не сходится с метаданными Диадока"
            description={d.mismatches.join('; ')}
          />
        )}

        <Collapse
          size="small"
          items={[
            ...(d.missingForCard.length
              ? [
                  {
                    key: 'missing',
                    label: 'Чего не хватает до карточки',
                    children: (
                      <Space direction="vertical" size={2}>
                        {d.missingForCard.map((m) => (
                          <Typography.Text key={m.field}>
                            <b>{m.field}:</b> {m.hint}
                          </Typography.Text>
                        ))}
                      </Space>
                    ),
                  },
                ]
              : []),
            {
              key: 'diadoc',
              label: `Что сообщает Диадок (${d.diadocFields.length})`,
              children: <FieldList fields={d.diadocFields} />,
            },
            ...(d.xmlOutline.length
              ? [
                  {
                    key: 'xml',
                    label: `Структура XML (${d.xmlOutline.length})`,
                    children: (
                      <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {d.xmlOutline.join('\n')}
                      </pre>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Space>
    </Card>
  );
}

function FieldList({ fields }: { fields: { path: string; value: string }[] }) {
  if (fields.length === 0) return <Typography.Text type="secondary">Полей нет</Typography.Text>;
  return (
    <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {fields.map((f) => `${f.path} = ${f.value}`).join('\n')}
    </pre>
  );
}
