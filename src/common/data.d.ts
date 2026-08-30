import { ITreeNodeData } from './tree'

export type HostsType = 'local' | 'remote' | 'group' | 'folder'
export type FolderModeType = 0 | 1 | 2 // 0: 默认; 1: 单选; 2: 多选

export interface IHostsListObject {
  id: string
  title?: string
  on?: boolean
  type?: HostsType

  // remote
  url?: string
  last_refresh?: string
  last_refresh_ms?: number
  refresh_interval?: number // 单位：秒
  // 可选：刷新远程内容后，将下载的内容另存到该文件路径
  save_path?: string
  // 内容用途：false = 仅定时抓取/触发（不写入 hosts）；缺省/true = 作为 hosts 内容
  as_hosts?: boolean
  // 是否在右侧主编辑器区域显示内容：缺省/true = 显示；false = 隐藏
  show_content?: boolean
  // 下载型方案的通知：当前渠道（wecom 企业微信 / dingtalk 钉钉 / other 其他）
// webhook 地址列表已迁移到全局配置（ConfigsType.notify_webhooks），所有方案共用一份
// 此处仅保留面板状态（渠道选择）和 per-scheme 的消息模板/格式
notify_channel?: string
// 自定义通知内容（支持占位符 {title} {result} {message}）与格式（text / markdown）
notify_message?: string
notify_format?: 'text' | 'markdown'

  // group
  include?: string[]

  // folder
  folder_mode?: FolderModeType
  folder_open?: boolean
  children?: IHostsListObject[]

  is_sys?: boolean

  [key: string]: any
}

export interface IHostsContentObject {
  id: string
  content: string

  [key: string]: any
}

export interface ITrashcanObject {
  data: IHostsListObject
  add_time_ms: number
  parent_id: string | null
}

export interface ITrashcanListObject extends ITrashcanObject, ITreeNodeData {
  id: string
  children?: ITrashcanListObject[]
  is_root?: boolean
  type?: HostsType | 'trashcan'

  [key: string]: any
}

export interface IHostsHistoryObject {
  id: string
  content: string
  add_time_ms: number
  label?: string
}

export type VersionType = string

export interface IHostsBasicData {
  list: IHostsListObject[]
  trashcan: ITrashcanObject[]
  version: VersionType
}

export interface IOperationResult {
  success: boolean
  message?: string
  data?: any
  code?: string | number
}

export interface ICommandRunResult {
  _id?: string
  success: boolean
  stdout: string
  stderr: string
  add_time_ms: number
}
