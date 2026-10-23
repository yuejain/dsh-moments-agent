/**
 * 文件路径边界校验。
 *
 * 媒体素材、截图、日志、数据库路径都可能来自配置或模型输入。
 * 所有落盘路径必须先经过本模块，避免路径穿越与符号链接逃逸。
 */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { MomentsError } from '../domain/result.js';

/** 判断 child 是否位于 parent 内（含 parent 本身）。 */
export function isInside(parent: string, child: string): boolean {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 把用户/模型提供的路径解析为 root 内的绝对路径。
 * - 拒绝绝对路径逃逸、`..` 逃逸、Windows 盘符切换；
 * - 若目标已存在，额外用 realpath 校验，防止符号链接指向外部。
 */
export function resolveInsideRoot(root: string, candidate: string, label = '路径'): string {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new MomentsError('IMAGE_PATH_DENIED', `${label}不能为空`);
  }
  if (candidate.includes('\0')) {
    throw new MomentsError('IMAGE_PATH_DENIED', `${label}包含非法字符`);
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, candidate);
  if (!isInside(rootResolved, target)) {
    throw new MomentsError('IMAGE_PATH_DENIED', `${label}越界：只允许访问工作目录内的文件`, {
      details: { root: rootResolved },
    });
  }
  try {
    const real = realpathSync(target);
    if (!isInside(realpathSync(rootResolved), real)) {
      throw new MomentsError('IMAGE_PATH_DENIED', `${label}通过符号链接指向工作目录外部`);
    }
    return real;
  } catch (error) {
    if (error instanceof MomentsError) throw error;
    // 目标尚不存在（例如待写入文件）时，回到词法校验结果。
    return target;
  }
}

/** 判断目标是否为普通文件，拒绝目录、设备与符号链接。 */
export function assertRegularFile(target: string, label = '文件'): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    throw new MomentsError('NOT_FOUND', `${label}不存在`);
  }
  if (stat.isSymbolicLink()) throw new MomentsError('IMAGE_PATH_DENIED', `${label}不能是符号链接`);
  if (!stat.isFile()) throw new MomentsError('IMAGE_PATH_DENIED', `${label}不是普通文件`);
}

/** 防止 Windows 保留设备名被当作普通文件写入。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function assertSafeFileName(name: string): string {
  if (name === '.' || name === '..' || /[\\/:*?"<>|\0-\x1f]/.test(name)) {
    throw new MomentsError('IMAGE_PATH_DENIED', '文件名包含非法字符');
  }
  if (WINDOWS_RESERVED.test(name)) throw new MomentsError('IMAGE_PATH_DENIED', '文件名是 Windows 保留设备名');
  if (name.length > 200) throw new MomentsError('IMAGE_PATH_DENIED', '文件名过长');
  return name;
}
