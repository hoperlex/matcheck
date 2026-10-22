/**
 * Окна портала не выходят за край экрана — как окна FOT: окно по центру (сам
 * centered включён в ConfigProvider, App.tsx), не выше экрана минус 16px сверху
 * и снизу, шапка и подвал на месте, прокручивается только тело.
 *
 * Раньше у antd Modal высота не ограничивалась ничем: окно стояло на 100px от
 * верха, и длинное содержимое (окно подбора УПД из ЭДО с подсказками и
 * таблицей) уезжало за нижний край — прокручивалась вся обёртка вместе с
 * шапкой.
 *
 * Окно-«экран» (просмотрщики, разбор письма) получает rootClassName
 * `mc-modal-fill`: высота задаётся самому окну, тело заполняет остаток. Только
 * так у тела определённая высота и дети с height:100% (iframe, фото, Splitter)
 * растягиваются по нему. Если вместо этого задать высоту телу, окно, упёршись в
 * потолок, сожмёт тело flex'ом, а дети останутся прежней высоты и обрежутся.
 *
 * Свой inline-стиль тела (styles.body / bodyStyle) сильнее этих правил по
 * каждому свойству. Специфичность — как у TableLookStyle: стили antd обёрнуты в
 * `:where(.css-…)`, и префикса `.ant-modal-root` хватает.
 */
const CSS = `
.ant-modal-root .ant-modal-content {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
}
/* Окно без centered (статический Modal.* без centered, centered={false})
   стоит на 100px от верха с отступом 24px снизу — дефолты antd. */
.ant-modal-root .ant-modal-wrap:not(.ant-modal-centered) .ant-modal-content {
  max-height: calc(100vh - 124px);
  max-height: calc(100dvh - 124px);
}
.ant-modal-root.mc-modal-fill .ant-modal-content {
  height: calc(100vh - 32px);
  height: calc(100dvh - 32px);
}
.ant-modal-root .ant-modal-header,
.ant-modal-root .ant-modal-footer { flex: none; }
/* Чипы в шапке (объект, поставщик, покупатель) — antd Tag в одну строку, и на
   телефоне «Объект: …» с длинным названием торчал за край окна. Не шире
   шапки, длинный текст переносится; короткие чипы выглядят как прежде. */
.ant-modal-root .ant-modal-header .ant-tag {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.ant-modal-root .ant-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
/* Прокручиваемое тело обрезает всё, что выходит за его край, а у antd тело
   без отступов: у кнопки на краю срезалось бы кольцо фокуса (3px + 1px).
   4px запаса внутрь и столько же отрицательного отступа — содержимое стоит на
   прежнем месте. Окна со своим padding тела запас уже имеют. */
.ant-modal-root .ant-modal-body:not([style*="padding"]) {
  margin: -4px;
  padding: 4px;
}
`;

export function ModalLookStyle() {
  return <style>{CSS}</style>;
}
