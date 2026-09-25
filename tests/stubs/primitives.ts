/**
 * Vitest alias stub for @deepseek-ai/dsh-client-ui-primitives: the client spec
 * never renders, so runtime imports resolve to inert dummies instead of
 * dragging the real package (and its css/react-dom/util deps) into node.
 */
import * as React from 'react';

const stub = (): React.ReactElement => React.createElement('span');
export const IconChecklistOutlineRegular = stub;
export const IconSparkleRegular = stub;
export const IconPlayOutlineRegular = stub;
export const IconStopFillRegular = stub;
export const IconCloseOutlineRegular = stub;
export const IconRefreshOutlineRegular = stub;
export const IconEditOutlineRegular = stub;
export const IconTrashOutlineRegular = stub;
export const IconShieldOutlineRegular = stub;
export const IconWarningOutlineRegular = stub;
export const IconTriangleRightFillRegular = stub;
export const IconNewChatOutlineRegular = stub;
export const IconChevronDownOutlineRegular = stub;
export const IconChevronUpOutlineRegular = stub;
export const IconChevronRightOutlineRegular = stub;
export const IconInspectOutlineRegular = stub;
export const IconListPenOutlineRegular = stub;
export const IconPinOutlineRegular = stub;
export const IconSendOutlineRegular = stub;
export default stub;
