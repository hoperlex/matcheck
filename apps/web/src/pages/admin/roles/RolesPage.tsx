import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { InfoCircleOutlined, PlusCircleFilled } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANAGED_ROLES,
  PAGE_ACTIONS,
  PAGE_ACTION_LABELS,
  expandBlockReason,
  PAGE_GROUPS,
  PAGE_GROUP_LABELS,
  RolePermissionConflictDetailsSchema,
  type ManagedRole,
  type PageAction,
  type PageGroup,
  type RolePermissionsResponse,
  type UserRole,
} from '@matcheck/contracts';
import { api, ApiError } from '../../../services/api';
import { StickyPageHeader } from '../../../shared/ui/StickyPageHeader';
import { ResponsiveTable } from '../../../shared/ui/ResponsiveTable';
import { roleLabel } from '../../../shared/constants/roleLabels';
import {
  applyCell,
  applyConflicts,
  applyGroup,
  cellState,
  cloneMatrix,
  commitRole,
  diffMatrix,
  groupState,
  isExtension,
  rebaseDraft,
  resetRole,
  roleHasChanges,
  type CatalogEntry,
  type Change,
  type Matrix,
} from './matrixDraft';

const ROLE_TABS: UserRole[] = ['admin', ...MANAGED_ROLES];

/**
 * Отказ из-за чужой правки: ячейку или роль успел изменить другой
 * администратор. Проверяем именно `code` — `name` у ApiError обычный «Error»,
 * и сверка по нему молча не срабатывала бы, оставляя человека жать «Сохранить»
 * по кругу.
 */
function isConflict(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'stale_cell' || err.code === 'stale_role');
}

/**
 * Ячейки, из-за которых сервер отказал, с их фактическими значениями.
 *
 * `null` означает «разобрать не удалось»: так отвечает сервер прошлой версии,
 * который подробностей не присылал. Веб и API выкатываются раздельно, и без
 * этой ветки новый интерфейс со старым сервером снова заперся бы в отказе,
 * который нечем исправить.
 */
function conflictCells(err: unknown) {
  if (!(err instanceof ApiError) || err.code !== 'stale_cell') return null;
  const body = err.payload as { details?: unknown } | undefined;
  const parsed = RolePermissionConflictDetailsSchema.safeParse(body?.details);
  return parsed.success ? parsed.data.conflicts : null;
}

/**
 * Подсказка под состоянием ячейки — почему её нельзя тронуть.
 *
 * `write-locked` здесь нет: причина у него разная (подрядчику запись закрыта
 * везде, инспектору — только там, где скоуп не проверяется), и одна общая
 * фраза «этой роли можно выдать только Просмотр» вводила бы в заблуждение.
 * Её даёт expandBlockReason из контрактов, рядом с самим правилом.
 */
const CELL_HINT: Record<string, string> = {
  locked:
    'Требуется мобильному приложению КПП: планшет не показывает ошибку доступа и просто перестанет работать',
  never:
    'Это право не выдаётся ни одной роли: через него можно получить полномочия администратора и отобрать доступ у остальных',
};

/** Разделы, выдача прав в которых даёт роли административные экраны. */
const ADMIN_GROUP: PageGroup = 'admin';

type Row = CatalogEntry;

export default function RolesPage() {
  const qc = useQueryClient();
  const [role, setRole] = useState<ManagedRole>('manager');
  const [adminSelected, setAdminSelected] = useState(false);
  const [draft, setDraft] = useState<Matrix | null>(null);

  const query = useQuery({
    queryKey: ['role-permissions'],
    queryFn: () => api.get<RolePermissionsResponse>('/admin/role-permissions'),
    // Фоновое обновление по возврату фокуса здесь вредит: страница держит
    // черновик, и ответ GET, вышедшего в полёт до сохранения, возвращал кеш к
    // прежней матрице уже ПОСЛЕ ответа PATCH. Снимок при этом уезжал на
    // значение, которого в БД давно нет, и следующее сохранение отбивалось
    // «ячейку изменил другой администратор» без всякого другого администратора.
    // Свежесть обеспечивает сверка expected на сервере, а не опрос.
    refetchOnWindowFocus: false,
  });

  const server = useMemo(
    () => (query.data ? (query.data.matrix as Matrix) : null),
    [query.data],
  );
  const lockedCells = useMemo(
    () => new Set(query.data?.lockedCells ?? []),
    [query.data?.lockedCells],
  );
  // Каталог берём ИЗ ОТВЕТА сервера, а не из @matcheck/contracts: при
  // раздельном выкате веба и API списки страниц разъедутся, и админ будет
  // править строки, которых сервер не знает.
  const catalog = query.data?.catalog ?? [];
  /** Сколько строк-отклонений у роли по последнему ответу сервера. */
  const overrideRowsOf = (r: ManagedRole) => query.data?.overrideRows?.[r] ?? 0;

  // Снимок на момент подъёма черновика — от НЕГО считается дельта. Брать
  // текущий ответ сервера нельзя: он обновляется фоновым рефетчем, и правка
  // соседа по той же ячейке попала бы в мою дельту как возврат к прежнему
  // значению, молча откатив чужую работу.
  const [baseSnapshot, setBaseSnapshot] = useState<Matrix | null>(null);

  useEffect(() => {
    if (!server) return;
    if (!draft || !baseSnapshot) {
      setDraft(cloneMatrix(server));
      setBaseSnapshot(cloneMatrix(server));
      return;
    }
    // Фоновый рефетч: нетронутые ячейки подтягиваем с сервера (иначе чужие
    // правки не видны до перезагрузки), тронутые — оставляем своими.
    const next = rebaseDraft(baseSnapshot, draft, server);
    setDraft(next.draft);
    setBaseSnapshot(next.base);
    // Зависимость намеренно одна — server. Добавить сюда draft/baseSnapshot
    // нельзя: ре-база запускалась бы на каждую правку ячейки и затирала бы её
    // сама собой. Значения читаются на момент прихода нового ответа сервера.
  }, [server]);

  // Роль, права которой сейчас редактируются. На вкладке «Администратор» её
  // нет: `role` продолжает хранить последнюю managed-роль, и без этого различия
  // кнопки сохранения работали бы там от имени скрытой вкладки.
  const activeRole: ManagedRole | null = adminSelected ? null : role;

  // Дельта по ВСЕМ ролям — для точек на вкладках и предупреждения об уходе.
  const changes = baseSnapshot && draft ? diffMatrix(baseSnapshot, draft) : [];
  const dirty = changes.length > 0;
  // Дельта активной вкладки — именно она уходит в PATCH. Раньше сохранялись все
  // роли разом: одна застрявшая ячейка отменяла транзакцию целиком, и правки
  // соседней роли не доезжали никогда, хотя человек их и не редактировал.
  const roleChanges = activeRole ? changes.filter((c) => c.role === activeRole) : [];
  const roleDirty = roleChanges.length > 0;

  // Уход со страницы с несохранёнными правками. useBlocker здесь не
  // применяем — вкладка живёт внутри AdminLayout, и достаточно предупредить
  // о закрытии/перезагрузке; навигацию человек делает осознанно, а черновик
  // не переживает перезагрузку в любом случае.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /**
   * Принять ответ мутации: кеш, черновик и снимок.
   *
   * `savedRole` приходит из variables мутации, а не из состояния: пока запрос в
   * полёте, вкладку могли переключить, и `role` указывал бы уже на другую роль —
   * подтверждённой оказалась бы не та.
   *
   * cancelQueries перед setQueryData обязателен: GET, ушедший в полёт до
   * мутации, иначе вернётся позже ответа и перезапишет свежую матрицу старой.
   */
  const acceptResponse = async (res: RolePermissionsResponse, savedRole: ManagedRole) => {
    await qc.cancelQueries({ queryKey: ['role-permissions'] });
    qc.setQueryData(['role-permissions'], res);
    const server = res.matrix as Matrix;
    if (!draft || !baseSnapshot) {
      setDraft(cloneMatrix(server));
      setBaseSnapshot(cloneMatrix(server));
      return;
    }
    // Черновики соседних ролей переживают сохранение: принимать всю матрицу
    // целиком нельзя, человек мог наставить галочек и на других вкладках.
    const next = commitRole(baseSnapshot, draft, server, savedRole);
    setDraft(next.draft);
    setBaseSnapshot(next.base);
  };

  /**
   * Отказ по конфликту. Сообщение о нём — не «сосед вас опередил»: чаще всего
   * расходится собственная вкладка, и прежняя формулировка вводила в
   * заблуждение.
   */
  const handleConflict = (err: Error, savedRole: ManagedRole): boolean => {
    const cells = conflictCells(err);
    if (cells) {
      // Двигаем снимок точечно на фактические значения — черновик остаётся
      // выбором человека. После этого повтор уходит с верным expected.
      setBaseSnapshot((b) => (b ? applyConflicts(b, cells) : b));
      message.error('Часть ячеек на сервере уже изменилась — проверьте отмеченные и повторите');
      void query.refetch();
      return true;
    }
    if (isConflict(err)) {
      // Подробностей нет — это сервер прошлой версии. Двигать снимок вслепую
      // нечем, поэтому откатываем роль к серверу и говорим об этом прямо:
      // иначе человек жал бы «Сохранить» по кругу с тем же результатом.
      if (server && draft && baseSnapshot) {
        const next = resetRole(baseSnapshot, draft, server, savedRole);
        setDraft(next.draft);
        setBaseSnapshot(next.base);
      }
      message.error('Состояние на сервере изменилось — правки этой роли отменены, повторите');
      void query.refetch();
      return true;
    }
    return false;
  };

  const save = useMutation({
    mutationFn: (vars: { role: ManagedRole; changes: Change[] }) =>
      api.patch<RolePermissionsResponse>('/admin/role-permissions', { changes: vars.changes }),
    onSuccess: async (res, vars) => {
      await acceptResponse(res, vars.role);
      message.success('Права сохранены');
    },
    onError: (err: Error, vars) => {
      if (handleConflict(err, vars.role)) return;
      message.error(err.message);
    },
  });

  const reset = useMutation({
    mutationFn: (target: ManagedRole) =>
      // Сколько строк-отклонений у роли я видел. Сервер сверит и откажет
      // (409), если сосед успел что-то добавить или убрать: сброс стирает
      // строки целиком, и делать это по устаревшей картине нельзя.
      api.delete<RolePermissionsResponse>(
        `/admin/role-permissions/${target}?expectedRows=${overrideRowsOf(target)}`,
      ),
    onSuccess: async (res, target) => {
      await acceptResponse(res, target);
      message.success('Права роли сброшены к значениям по умолчанию');
    },
    onError: (err: Error, target) => {
      if (handleConflict(err, target)) return;
      message.error(err.message);
    },
  });

  /**
   * Любая мутация в полёте. Общий флаг, а не два раздельных: иначе сохранение и
   * сброс можно запустить одновременно, а клик по галочке после нажатия
   * «Сохранить» пропал бы — ответ принимает роль с сервера целиком.
   */
  const busy = save.isPending || reset.isPending;

  if (query.isLoading || !draft || !server) {
    return (
      <div style={{ padding: 24 }}>
        <Spin />
      </div>
    );
  }
  if (query.isError) {
    return <Alert type="error" showIcon message="Не удалось загрузить матрицу прав" />;
  }

  const toggleCell = (entry: Row, action: PageAction, allowed: boolean) => {
    setDraft((d) => (d ? applyCell(d, entry, role, action, allowed, lockedCells) : d));
  };

  const toggleGroup = (entries: Row[], action: PageAction, allowed: boolean) => {
    setDraft((d) => (d ? applyGroup(d, entries, role, action, allowed, lockedCells) : d));
  };

  const renderCell = (entry: Row, action: PageAction) => {
    const state = cellState(entry, role, action, lockedCells);
    // Неприменимое действие не рисуем вовсе: прочерк ломал бы выравнивание
    // колонки, а пустая ячейка читается как «нет такого измерения».
    if (state === 'not-applicable') return null;
    const checked = state === 'locked' ? true : Boolean(draft[role]?.[entry.id]?.[action]);
    // Право сверх базового набора роли: администратор должен видеть, где он
    // расширил доступ, а где просто оставил как было.
    const extension = isExtension(entry, role, action, checked);
    const box = (
      <Checkbox
        checked={checked}
        // busy: ответ мутации принимает роль с сервера целиком, и клик,
        // сделанный после нажатия «Сохранить», был бы молча съеден.
        disabled={state !== 'editable' || busy}
        onChange={(e) => toggleCell(entry, action, e.target.checked)}
      />
    );
    // Честная маркировка: та же ручка может кормить и вкладку, и комбобоксы
    // формы приёмки, и мобильный /sync. Тогда снятая галочка убирает раздел из
    // меню, но данные по API остаются — и знать это администратор должен до
    // того, как на неё понадеется.
    const coverage = query.data?.cellCoverage?.[`${entry.id}:${action}`];
    const coverageHint =
      coverage === 'portal-only'
        ? 'Действует только в портале: раздел исчезнет из меню, но те же данные останутся доступны по API — эти маршруты кормят и форму приёмки, и мобильное приложение'
        : coverage === 'partial'
          ? 'Действует не полностью: часть маршрутов этой ячейки вне матрицы, данные по ним останутся доступны по API'
          : null;

    const hint = extension
      ? 'Право выдано сверх базового набора роли'
      : state === 'write-locked'
        ? expandBlockReason(role, entry.id, action)
        : (CELL_HINT[state] ?? coverageHint);
    // Значок неполного покрытия — только у включённой галочки: у снятой
    // оговорка бессмысленна, там и скрывать нечего.
    const partialMark = coverageHint && checked && !extension && (
      <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 11 }} />
    );
    const wrapped =
      extension || partialMark ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {box}
          {extension && <PlusCircleFilled style={{ color: '#fa8c16', fontSize: 11 }} />}
          {partialMark}
        </span>
      ) : (
        box
      );
    return hint ? (
      <Tooltip title={hint}>
        <span>{wrapped}</span>
      </Tooltip>
    ) : (
      wrapped
    );
  };

  const groupsWithPages: { group: PageGroup; entries: Row[] }[] = PAGE_GROUPS.map((g) => ({
    group: g,
    entries: catalog.filter((c) => c.group === g),
  })).filter((g) => g.entries.length > 0);

  const isAdminView = adminSelected;

  // Среди несохранённых правок есть выдача прав на раздел «Администрирование».
  // Такое сохранение подтверждаем отдельно: это полномочия уровня админа.
  const grantsAdminAccess = roleChanges.some((c) => {
    if (!c.allowed) return false;
    const entry = catalog.find((e) => e.id === c.page);
    return entry?.group === ADMIN_GROUP && !entry.base[c.action]?.includes(c.role);
  });

  return (
    <StickyPageHeader
      header={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space wrap>
              {ROLE_TABS.map((r) => {
                const isAdminRole = r === 'admin';
                const active = isAdminRole ? adminSelected : !adminSelected && r === role;
                // От снимка, а не от текущего сервера: иначе чужая правка
                // подсвечивалась бы как моя несохранённая.
                const changed =
                  !isAdminRole &&
                  baseSnapshot != null &&
                  roleHasChanges(baseSnapshot, draft, r as ManagedRole);
                return (
                  <Button
                    key={r}
                    type={active ? 'primary' : 'default'}
                    // Пока мутация в полёте, роль менять нельзя: ответ принимает
                    // роль из variables, и уехавшая вкладка сбивала бы с толку.
                    disabled={busy}
                    onClick={() => {
                      setAdminSelected(isAdminRole);
                      if (!isAdminRole) setRole(r as ManagedRole);
                    }}
                  >
                    <Badge dot={changed} offset={[4, -2]}>
                      {roleLabel(r)}
                    </Badge>
                  </Button>
                );
              })}
            </Space>
            <Space wrap>
              {/* Тег — про активную вкладку. Общий на все роли висел и тогда,
                  когда правки лежали на соседней, и читался как «сохранение не
                  прошло». */}
              {roleDirty && <Tag color="orange">Есть несохранённые изменения</Tag>}
              <Button
                // Откат только активной роли: черновики соседних вкладок — это
                // работа, которую человек не просил выбрасывать.
                onClick={() => {
                  if (!activeRole || !baseSnapshot) return;
                  const next = resetRole(baseSnapshot, draft, server, activeRole);
                  setDraft(next.draft);
                  setBaseSnapshot(next.base);
                }}
                disabled={!roleDirty || busy}
              >
                Отменить
              </Button>
              <Popconfirm
                title={`Сбросить права роли «${roleLabel(role)}» к значениям по умолчанию?`}
                okText="Сбросить"
                cancelText="Отмена"
                onConfirm={() => activeRole && reset.mutate(activeRole)}
                disabled={!activeRole || busy}
              >
                <Button danger disabled={!activeRole || busy} loading={reset.isPending}>
                  Сбросить к дефолту
                </Button>
              </Popconfirm>
              {grantsAdminAccess ? (
                <Popconfirm
                  title="Выдать роли административные права?"
                  description={
                    <div style={{ maxWidth: 360 }}>
                      Роль получит экраны раздела «Администрирование». Это полномочия уровня
                      администратора — убедитесь, что доступ действительно нужен для работы.
                    </div>
                  }
                  okText="Выдать"
                  cancelText="Отмена"
                  onConfirm={() =>
                    activeRole && save.mutate({ role: activeRole, changes: roleChanges })
                  }
                >
                  <Button type="primary" disabled={!roleDirty || busy} loading={save.isPending}>
                    Сохранить
                  </Button>
                </Popconfirm>
              ) : (
                <Button
                  type="primary"
                  disabled={!roleDirty || busy}
                  loading={save.isPending}
                  onClick={() =>
                    activeRole && save.mutate({ role: activeRole, changes: roleChanges })
                  }
                >
                  Сохранить
                </Button>
              )}
            </Space>
          </Space>
          {!query.data?.enforced && (
            <Alert
              type="info"
              showIcon
              message="Применение прав выключено"
              description="Матрица сохраняется, но пока не действует: сервер запущен с PERMISSIONS_ENFORCE=0. Настройки оживут после включения."
            />
          )}
          {isAdminView && (
            <Alert
              type="warning"
              showIcon
              message="Права администратора не настраиваются"
              description="Это единственная роль, которая может вернуть доступ остальным: закрыв ей что-либо, восстановить настройки было бы уже нечем."
            />
          )}
        </Space>
      }
    >
      {groupsWithPages.map(({ group, entries }) => (
        <Card
          key={group}
          size="small"
          style={{ marginBottom: 12 }}
          title={
            <Space wrap size={16}>
              <Typography.Text strong>{PAGE_GROUP_LABELS[group]}</Typography.Text>
              {!isAdminView &&
                PAGE_ACTIONS.map((action) => {
                  const st = groupState(draft, entries, role, action, lockedCells);
                  if (st.disabled && !st.checked) return null;
                  return (
                    <Checkbox
                      key={action}
                      checked={st.checked}
                      indeterminate={st.indeterminate}
                      disabled={st.disabled || busy}
                      onChange={(e) => toggleGroup(entries, action, e.target.checked)}
                    >
                      <Typography.Text type="secondary">
                        {PAGE_ACTION_LABELS[action]}
                      </Typography.Text>
                    </Checkbox>
                  );
                })}
            </Space>
          }
        >
          <ResponsiveTable<Row>
            items={entries}
            rowKey={(r) => r.id}
            pagination={false}
            // Разделов на странице шесть; общий «скролл во весь экран» рисовал
            // бы трек прокрутки в каждом. Скроллится страница целиком.
            scrollY={false}
            columns={[
              {
                title: 'Страница',
                dataIndex: 'label',
                // Фиксированная ширина: иначе на широком мониторе название
                // уезжает влево, а галочки жмутся к правому краю, и строку
                // тяжело вести глазом до нужной колонки.
                width: 360,
                render: (_: unknown, r: Row) => (
                  <Space size={6}>
                    <span>{r.label}</span>
                    {r.hidden && (
                      <Tooltip title="Пункта меню нет — страница открывается только по прямой ссылке">
                        <Tag>скрытая</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              // Колонка рисуется, только если действие осмысленно хотя бы для
              // одной страницы раздела. Иначе «Проверять» (есть лишь у
              // Операций) добавил бы пустой столбец во все шесть разделов.
              // Мобильная карточка ниже фильтрует по тому же признаку, но
              // построчно.
              ...PAGE_ACTIONS.filter((action) => entries.some((e) => e.actions.includes(action)))
                .map((action) => ({
                  title: PAGE_ACTION_LABELS[action],
                  key: action,
                  align: 'center' as const,
                  render: (_: unknown, r: Row) =>
                    isAdminView ? (
                      <Checkbox checked disabled />
                    ) : (
                      renderCell(r, action)
                    ),
                })),
            ]}
            cardRender={(r) => (
              <Card size="small" style={{ width: '100%' }}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text strong>{r.label}</Typography.Text>
                  <Space wrap size={12}>
                    {PAGE_ACTIONS.filter((a) => r.actions.includes(a)).map((action) => (
                      <Space key={action} size={4}>
                        {isAdminView ? <Checkbox checked disabled /> : renderCell(r, action)}
                        <Typography.Text type="secondary">
                          {PAGE_ACTION_LABELS[action]}
                        </Typography.Text>
                      </Space>
                    ))}
                  </Space>
                </Space>
              </Card>
            )}
          />
        </Card>
      ))}
    </StickyPageHeader>
  );
}
