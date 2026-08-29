/**
 * @author: oldj
 * @homepage: https://oldj.net
 */

import { FolderModeType, HostsType, IHostsListObject } from '@common/data'
import events from '@common/events'
import * as hostsFn from '@common/hostsFn'
import {
  ActionIcon,
  Box,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import DescriptionText from '@renderer/components/DescriptionText'
import ItemIcon from '@renderer/components/ItemIcon'
import SideDrawer from '@renderer/components/SideDrawer'
import Transfer from '@renderer/components/Transfer'
import { actions, agent } from '@renderer/core/agent'
import { showErrorNotification } from '@renderer/core/notify'
import useOnBroadcast from '@renderer/core/useOnBroadcast'
import { formatInterval } from '@renderer/utils/formatInterval'
import lodash from 'lodash'
import React, { useRef, useState } from 'react'
import { BiEdit, BiFolderOpen, BiPlus, BiTrash } from 'react-icons/bi'
import { v4 as uuidv4 } from 'uuid'
import useHostsData from '../models/useHostsData'
import useI18n from '../models/useI18n'
import styles from './EditHostsInfo.module.scss'

// 自动刷新预设间隔（单位：秒），与 Select 选项保持一致
const REFRESH_PRESETS = [0, 60, 60 * 5, 60 * 15, 60 * 60, 60 * 60 * 24, 60 * 60 * 24 * 7]

// 自定义刷新时间的单位（秒/分钟/小时/天）
const CUSTOM_UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
} as const
type CustomUnitKey = keyof typeof CUSTOM_UNIT_SECONDS

// 为当前间隔挑选一个「换算后为整数」的最合适单位（天 > 小时 > 分钟 > 秒）
const deriveCustomUnit = (interval: number): CustomUnitKey => {
  if (interval <= 0) return 'm'
  const order: CustomUnitKey[] = ['d', 'h', 'm', 's']
  for (const u of order) {
    if (interval % CUSTOM_UNIT_SECONDS[u] === 0) return u
  }
  return 's'
}

// 从 URL 的最后一个路径段提取默认文件名（保留扩展名，如
// .../PortableGit-2.55.0.5-64-bit.7z.exe → PortableGit-2.55.0.5-64-bit.7z.exe）；
// 取不到（无路径段/解析失败）返回空字符串。
const defaultNameFromUrl = (url?: string): string => {
  if (!url) return ''
  try {
    const u = new URL(url)
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    return seg || ''
  } catch {
    return ''
  }
}

const EditHostsInfo = () => {
  const { lang } = useI18n()
  const [hosts, setHosts] = useState<IHostsListObject | null>(null)
  const { hostsData, setList, currentHosts, setCurrentHosts } = useHostsData()
  const [isShow, setIsShow] = useState(false)
  const [isAdd, setIsAdd] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  // 自定义刷新时间的单位；null 表示随当前间隔自动推导
  const [customUnit, setCustomUnit] = useState<CustomUnitKey | null>(null)
  // Webhook 输入框引用（用于 ↑/↓ 方向键在多个 webhook 间切换焦点）
  const webhookRefs = useRef<(HTMLInputElement | null)[]>([])

  const onCancel = () => {
    setHosts(null)
    setIsShow(false)
  }

  const onSave = async () => {
    const data: Omit<IHostsListObject, 'id'> & { id?: string } = { ...hosts }

    const keysToTrim = ['title', 'url']
    keysToTrim.map((k) => {
      if (data[k]) {
        data[k] = data[k].trim()
      }
    })

    if (isAdd) {
      const h: IHostsListObject = {
        ...data,
        id: uuidv4(),
      }
      const list: IHostsListObject[] = [...hostsData.list, h]
      await setList(list)
      agent.broadcast(events.select_hosts, h.id, 1000)
    } else if (data && data.id) {
      const h: IHostsListObject | undefined = hostsFn.findItemById(hostsData.list, data.id)
      if (h) {
        Object.assign(h, data)
        await setList([...hostsData.list])

        if (data.id === currentHosts?.id) {
          setCurrentHosts(h)
        }
      } else {
        setIsAdd(true)
        setTimeout(onSave, 300)
        return
      }
    } else {
      showErrorNotification({ title: lang.fail, message: lang.unknown_error })
    }

    setIsShow(false)
  }

  const onUpdate = (kv: Partial<IHostsListObject>) => {
    const obj: IHostsListObject = Object.assign({}, hosts, kv)
    setHosts(obj)
  }

  useOnBroadcast(events.edit_hosts_info, (hosts?: IHostsListObject) => {
    setHosts(hosts || null)
    setIsAdd(!hosts)
    setIsShow(true)
  })

  useOnBroadcast(events.add_new, () => {
    setHosts(null)
    setIsAdd(true)
    setIsShow(true)
  })

  useOnBroadcast(
    events.hosts_refreshed,
    (_hosts: IHostsListObject) => {
      if (hosts && hosts.id === _hosts.id) {
        onUpdate(lodash.pick(_hosts, ['last_refresh', 'last_refresh_ms']))
      }
    },
    [hosts],
  )

  const onBrowseSavePath = async () => {
    if (!hosts) return

    // 默认文件名优先从 URL 最后一段推导（保留下载文件的扩展名），
    // 取不到再退回「标题.hosts」。
    const title = (hosts.title || '').trim()
    const defaultName =
      defaultNameFromUrl(hosts.url) ||
      (title ? `${title.replace(/[\\/:*?"<>|]/g, '_')}.hosts` : 'hosts.hosts')
    try {
      const picked = await actions.pickSavePath(defaultName)
      if (typeof picked === 'string' && picked) {
        onUpdate({ save_path: picked })
      }
    } catch (e) {
      console.error(e)
    }
  }

  const forRemote = (): React.ReactElement => {
    const interval = hosts?.refresh_interval || 0
    const isPreset = REFRESH_PRESETS.includes(interval)
    const selectValue = isPreset ? interval.toString() : interval > 0 ? 'custom' : '0'
    const selectData = [
      ...REFRESH_PRESETS.map((s) => ({
        value: s.toString(),
        label: formatInterval(s, lang),
      })),
      // 当前自定义间隔不在预设列表中时，追加一个“自定义”选项以便回显
      ...(!isPreset && interval > 0
        ? [{ value: 'custom', label: `${lang.custom} (${formatInterval(interval, lang)})` }]
        : []),
    ]
    const unit = customUnit ?? deriveCustomUnit(interval)
    const unitSecs = CUSTOM_UNIT_SECONDS[unit]

    // 通知：按渠道各自独立的 webhook 表单
    const notifyChannel = hosts?.notify_channel
    const channelLabel =
      notifyChannel === 'dingtalk'
        ? lang.notify_dingtalk
        : notifyChannel === 'other'
          ? lang.notify_other
          : lang.notify_wecom
    const notifyWebhooksAll = hosts?.notify_webhooks || {}
    // 当前渠道的 webhook 列表。回退旧版共用 webhooks 字段仅当该节点
    // 【完全没有】notify_webhooks（纯旧版数据、且恰好是当初的渠道）；
    // 一旦用户编辑过（写入 notify_webhooks 后），或切到其他渠道，
    // 一律显示空表单——切换选项不再串出企业微信的内容。
    const channelWebhooks = notifyChannel
      ? notifyWebhooksAll[notifyChannel] ??
        (!hosts?.notify_webhooks && Array.isArray(hosts?.webhooks)
          ? (hosts.webhooks as string[])
          : [])
      : []
    const setChannelWebhooks = (next: string[]) => {
      if (!notifyChannel) return
      onUpdate({ notify_webhooks: { ...notifyWebhooksAll, [notifyChannel]: next } })
    }
    // 钉钉「加签」密钥列表（与当前渠道 webhook 下标一一对应）
    const channelSecrets =
      notifyChannel === 'dingtalk' ? hosts?.notify_webhook_secrets?.['dingtalk'] || [] : []
    const setChannelSecrets = (next: string[]) => {
      if (notifyChannel !== 'dingtalk') return
      onUpdate({
        notify_webhook_secrets: {
          ...(hosts?.notify_webhook_secrets || {}),
          dingtalk: next,
        },
      })
    }

    return (
      <>
        <Box className={styles.ln}>
          <Text mb="8px">URL</Text>
          <TextInput
            aria-label="URL"
            value={hosts?.url || ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ url: e.target.value })}
            placeholder={lang.url_placeholder}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onSave()}
          />
        </Box>

        <Box className={styles.ln}>
          <Text mb="8px">{lang.auto_refresh}</Text>
          <Group gap="8px" align="flex-start" wrap="wrap">
            <Select
              aria-label={lang.auto_refresh}
              value={selectValue}
              onChange={(v) => {
                if (!v || v === 'custom') return
                setCustomUnit(null)
                onUpdate({ refresh_interval: parseInt(v, 10) || 0 })
              }}
              data={selectData}
              w={170}
              allowDeselect={false}
            />
            <NumberInput
              aria-label={lang.custom}
              min={0}
              step={1}
              clampBehavior="blur"
              w={120}
              value={interval / unitSecs}
              onChange={(v) =>
                onUpdate({ refresh_interval: Math.round((Number(v) || 0) * unitSecs) })
              }
            />
            <Select
              aria-label={lang.custom}
              value={unit}
              onChange={(v) => {
                if (v === 's' || v === 'm' || v === 'h' || v === 'd') setCustomUnit(v)
              }}
              data={[
                { value: 's', label: lang.second },
                { value: 'm', label: lang.minute },
                { value: 'h', label: lang.hour },
                { value: 'd', label: lang.day },
              ]}
              w={110}
              allowDeselect={false}
            />
          </Group>
          {isAdd ? null : (
            <Box className={styles.refresh_info} mt="8px">
              <span>
                {lang.last_refresh}
                {hosts?.last_refresh || 'N/A'}
              </span>
              <Button
                size="sm"
                variant="subtle"
                disabled={isRefreshing}
                onClick={() => {
                  if (!hosts) return

                  setIsRefreshing(true)
                  actions
                    .refreshHosts(hosts.id)
                    .then((r) => {
                      if (!r.success) {
                        console.error(r.message || r.code || 'Error!')
                        return
                      }

                      onUpdate({
                        last_refresh: r.data.last_refresh,
                        last_refresh_ms: r.data.last_refresh_ms,
                      })
                    })
                    .catch((e) => {
                      console.error(e.message)
                    })
                    .finally(() => setIsRefreshing(false))
                }}
              >
                {lang.refresh}
              </Button>
            </Box>
          )}
        </Box>

        <Box className={styles.ln}>
          <Text mb="8px">{lang.as_hosts}</Text>
          <Switch
            aria-label={lang.as_hosts}
            checked={hosts?.as_hosts !== false}
            onChange={(e) => onUpdate({ as_hosts: e.currentTarget.checked })}
          />
          <DescriptionText mt="8px">{lang.as_hosts_desc}</DescriptionText>
        </Box>

        <Box className={styles.ln}>
          <Text mb="8px">{lang.save_path}</Text>
          <Group gap="8px" align="flex-start" wrap="wrap">
            <TextInput
              aria-label={lang.save_path}
              className={styles.save_path_input}
              value={hosts?.save_path || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onUpdate({ save_path: e.target.value })
              }
            />
            <Button
              variant="default"
              leftSection={<BiFolderOpen />}
              onClick={() => {
                onBrowseSavePath()
              }}
            >
              {lang.browse}
            </Button>
          </Group>
          <DescriptionText mt="8px">{lang.save_path_desc}</DescriptionText>
        </Box>

        <Box className={styles.ln}>
          <Text mb="8px">{lang.notify}</Text>
          <Select
            aria-label={lang.notify}
            placeholder={lang.notify}
            clearable
            allowDeselect
            value={hosts?.notify_channel || ''}
            onChange={(v) => onUpdate({ notify_channel: v || undefined })}
            data={[
              { value: 'wecom', label: lang.notify_wecom },
              { value: 'dingtalk', label: lang.notify_dingtalk },
              { value: 'other', label: lang.notify_other },
            ]}
            w={180}
          />
          <DescriptionText mt="8px">{lang.notify_desc}</DescriptionText>
          {notifyChannel ? (
            // 表单按渠道各自独立：切到钉钉即显示钉钉自己的 webhook 列表，
            // 企业微信的列表原样保留（之后切回仍在），互不覆盖。
            <Box key={`notify-form-${notifyChannel}`} mt="4px">
              <Text size="sm" mb="4px" style={{ opacity: 0.7 }}>
                {channelLabel} Webhook
              </Text>
              {channelWebhooks.map((webhookUrl, idx) => (
                <Group key={`wh-${notifyChannel}-${idx}`} gap="6px" mt="6px" wrap="nowrap">
                  <TextInput
                    ref={(el) => {
                      webhookRefs.current[idx] = el
                    }}
                    value={webhookUrl}
                    placeholder={lang.url_placeholder}
                    style={{ flex: 1, minWidth: 0 }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const next = [...channelWebhooks]
                      next[idx] = e.target.value
                      setChannelWebhooks(next)
                    }}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      const count = channelWebhooks.length
                      if (e.key === 'ArrowUp' && idx > 0) {
                        e.preventDefault()
                        webhookRefs.current[idx - 1]?.focus()
                      }
                      if (e.key === 'ArrowDown' && idx < count - 1) {
                        e.preventDefault()
                        webhookRefs.current[idx + 1]?.focus()
                      }
                    }}
                  />
                  {notifyChannel === 'dingtalk' ? (
                    <TextInput
                      aria-label={lang.notify_dingtalk_secret}
                      value={channelSecrets[idx] || ''}
                      placeholder={lang.notify_dingtalk_secret}
                      w={170}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const next = [...channelSecrets]
                        while (next.length < channelWebhooks.length) next.push('')
                        next[idx] = e.currentTarget.value
                        setChannelSecrets(next)
                      }}
                    />
                  ) : null}
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={lang.delete}
                    onClick={() => {
                      const next = [...channelWebhooks]
                      next.splice(idx, 1)
                      setChannelWebhooks(next)
                    }}
                  >
                    <BiTrash />
                  </ActionIcon>
                </Group>
              ))}
              <Button
                mt="8px"
                size="xs"
                variant="light"
                leftSection={<BiPlus />}
                onClick={() => setChannelWebhooks([...channelWebhooks, ''])}
              >
                {lang.add_webhook}
              </Button>

              <Text mt="14px" mb="4px" size="sm">
                {lang.notify_message}
              </Text>
              <Textarea
                aria-label={lang.notify_message}
                value={hosts?.notify_message || ''}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  onUpdate({ notify_message: e.currentTarget.value })
                }
                placeholder={lang.notify_message_placeholder}
                minRows={2}
                autosize
              />
              <Text mt="10px" mb="4px" size="sm">
                {lang.notify_format}
              </Text>
              <SegmentedControl
                value={hosts?.notify_format || 'text'}
                onChange={(v) =>
                  onUpdate({ notify_format: v === 'markdown' ? 'markdown' : 'text' })
                }
                data={[
                  { value: 'text', label: lang.notify_format_text },
                  { value: 'markdown', label: lang.notify_format_markdown },
                ]}
              />
            </Box>
          ) : null}
        </Box>
      </>
    )
  }

  const renderTransferItem = (item: IHostsListObject): React.ReactElement => {
    return (
      <Group gap="8px">
        <ItemIcon type={item.type} />
        <span>{item.title || lang.untitled}</span>
      </Group>
    )
  }

  const forGroup = (): React.ReactElement => {
    const list = hostsFn.flatten(hostsData.list)

    const sourceList: IHostsListObject[] = list
      .filter((item) => !item.type || item.type === 'local' || item.type === 'remote')
      .map((item) => {
        const o = { ...item }
        o.key = o.id
        return o
      })

    const targetKeys: string[] = hosts?.include || []

    return (
      <Box className={styles.ln}>
        <Text mb="8px">{lang.content}</Text>
        <Transfer
          dataSource={sourceList}
          targetKeys={targetKeys}
          render={renderTransferItem}
          onChange={(nextTargetKeys) => {
            onUpdate({ include: nextTargetKeys })
          }}
        />
      </Box>
    )
  }

  const forFolder = (): React.ReactElement => {
    const folderMode = (hosts?.folder_mode || 0) as FolderModeType
    const choiceModeEffect: Record<FolderModeType, string> = {
      0: lang.choice_mode_default_effect,
      1: lang.choice_mode_single_effect,
      2: lang.choice_mode_multiple_effect,
    }

    return (
      <Box className={styles.ln}>
        <Text mb="8px">{lang.choice_mode}</Text>
        <SegmentedControl
          value={folderMode.toString()}
          onChange={(v) => onUpdate({ folder_mode: (parseInt(v) || 0) as FolderModeType })}
          data={[
            { value: '0', label: lang.choice_mode_default },
            { value: '1', label: lang.choice_mode_single },
            { value: '2', label: lang.choice_mode_multiple },
          ]}
        />
        <DescriptionText mt="8px">
          {choiceModeEffect[folderMode]}
        </DescriptionText>
      </Box>
    )
  }

  const types: HostsType[] = ['local', 'remote', 'group', 'folder']

  return (
    <SideDrawer
      opened={isShow}
      onClose={onCancel}
      size="lg"
      title={
        <Group gap="8px">
          <BiEdit />
          <Box>{isAdd ? lang.hosts_add : lang.hosts_edit}</Box>
        </Group>
      }
      scrollAreaStyle={{
        paddingBottom: 24,
      }}
      footer={
        <SimpleGrid cols={2} style={{ width: '100%', alignItems: 'center' }}>
          <Box>
            {isAdd ? null : (
              <Button
                variant="outline"
                disabled={!hosts}
                leftSection={<BiTrash />}
                onClick={() => {
                  if (hosts) {
                    agent.broadcast(events.move_to_trashcan, [hosts.id])
                    onCancel()
                  }
                }}
              >
                {lang.move_to_trashcan}
              </Button>
            )}
          </Box>
          <Group justify="flex-end" gap="12px">
            <Button onClick={onCancel} variant="outline">
              {lang.btn_cancel}
            </Button>
            <Button onClick={onSave}>{lang.btn_ok}</Button>
          </Group>
        </SimpleGrid>
      }
    >
      <Box>
        <Box className={styles.ln}>
          <Text mb="8px">{lang.hosts_type}</Text>
          <SegmentedControl
            value={hosts?.type || 'local'}
            onChange={(v) => onUpdate({ type: v as HostsType })}
            disabled={!isAdd}
            data={types.map((type) => ({
              value: type,
              label: (
                <Group gap="4px" wrap="nowrap">
                  <ItemIcon type={type} />
                  <span>{lang[type]}</span>
                </Group>
              ),
            }))}
          />
        </Box>

        <Box className={styles.ln}>
          <Text mb="8px">{lang.hosts_title}</Text>
          <TextInput
            aria-label={lang.hosts_title}
            data-autofocus
            value={hosts?.title || ''}
            maxLength={50}
            placeholder=""
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              onUpdate({ title: e.target.value })
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onSave()}
          />
        </Box>

        {hosts?.type === 'remote' ? forRemote() : null}
        {hosts?.type === 'group' ? forGroup() : null}
        {hosts?.type === 'folder' ? forFolder() : null}
      </Box>
    </SideDrawer>
  )
}

export default EditHostsInfo
