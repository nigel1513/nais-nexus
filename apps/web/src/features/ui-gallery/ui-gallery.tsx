"use client";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Combobox,
  CommandMenu,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  Input,
  Kbd,
  Menu,
  MiniHistogram,
  PathText,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Progress,
  Radio,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectMenu,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Textarea,
  Tooltip,
  buttonClass,
  cn,
  notify,
  type DataColumn,
} from "@nais/ui";
import {
  ArrowDownToLine,
  Bell,
  Columns3,
  Copy,
  Database,
  FileText,
  FolderOpen,
  LayoutList,
  MoreHorizontal,
  Pencil,
  Plus,
  Rows3,
  Settings,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";

/* Dev-only reviewer page: literal Korean copy is deliberate (not user-facing, not in messages/*.json). */

const ORGS = [
  { id: "keri", name: "한국전기연구원", unit: "차세대전지연구센터" },
  { id: "kimm", name: "한국기계연구원", unit: "에너지기계연구본부" },
  { id: "krict", name: "한국화학연구원", unit: "에너지소재연구단" },
  { id: "kist", name: "한국과학기술연구원", unit: "에너지저장연구센터" },
];

type FileRow = { id: string; path: string; role: string; rows: number; size: string; status: "ok" | "warn" | "fail" };
const FILES: FileRow[] = [
  { id: "1", path: "raw/cell-0042/cycle_001-200.csv", role: "RAW", rows: 1_284_310, size: "212.4 MB", status: "ok" },
  { id: "2", path: "processed/capacity_fade.parquet", role: "PROCESSED", rows: 48_200, size: "6.1 MB", status: "ok" },
  { id: "3", path: "processed/impedance_eis.parquet", role: "PROCESSED", rows: 9_812, size: "1.2 MB", status: "warn" },
  { id: "4", path: "docs/protocol_v3.pdf", role: "DOCS", rows: 0, size: "840 KB", status: "fail" },
];
const STATUS = {
  ok: { tone: "success", label: "검증됨" },
  warn: { tone: "warning", label: "경고 2건" },
  fail: { tone: "danger", label: "실패" },
} as const;
const COLUMNS: DataColumn<FileRow>[] = [
  { key: "path", header: "경로", cell: (r) => <PathText value={r.path} className="max-w-60" /> },
  { key: "role", header: "역할", cell: (r) => <Badge tone={r.role === "RAW" ? "neutral" : r.role === "DOCS" ? "info" : "accent"}>{r.role}</Badge> },
  { key: "rows", header: "행", numeric: true, cell: (r) => (r.rows ? r.rows.toLocaleString("ko-KR") : "—") },
  { key: "size", header: "크기", numeric: true, cell: (r) => r.size },
  { key: "status", header: "상태", cell: (r) => <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} /> },
];

const VOLTAGE = [2, 5, 9, 14, 22, 31, 38, 41, 36, 28, 19, 12, 8, 6, 3, 1];
const TEMP = [12, 18, 25, 30, 26, 14, 6, 9, 15, 11, 5, 2];

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: (theme: "light" | "dark") => ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="border-t border-border py-8 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${id}-h`} className="text-title text-fg">
          {title}
        </h2>
        <p className="text-small text-fg-muted">{note}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          // Each column forces its own theme, so both are visible whatever the page theme is.
          <div key={theme} className={cn(theme, "min-w-0 rounded-md border border-border bg-bg p-5 text-fg")}>
            <p className="mb-4 font-mono text-caption uppercase text-fg-muted">{theme}</p>
            {children(theme)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="grid gap-2 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <span className="text-caption text-fg-muted">{label}</span>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>{children}</div>
    </div>
  );
}

function Buttons() {
  return (
    <div>
      <Row label="variant">
        <Button variant="primary">
          <Plus aria-hidden="true" />새 데이터셋
        </Button>
        <Button variant="secondary">취소</Button>
        <Button variant="ghost">더 보기</Button>
        <Button variant="danger">
          <Trash2 aria-hidden="true" />
          삭제
        </Button>
      </Row>
      <Row label="size">
        <Button variant="primary" size="sm">
          sm 28
        </Button>
        <Button variant="primary">md 32</Button>
        <Button variant="primary" size="lg">
          lg 40
        </Button>
        <Button size="sm">
          <ArrowDownToLine aria-hidden="true" />
          내려받기
        </Button>
      </Row>
      <Row label="state">
        <Button variant="primary" loading>
          발행
        </Button>
        <Button variant="secondary" loading>
          저장
        </Button>
        <Button variant="primary" disabled>
          발행
        </Button>
        <Button disabled>취소</Button>
      </Row>
      <Row label="icon">
        <IconButton label="편집">
          <Pencil aria-hidden="true" />
        </IconButton>
        <IconButton label="복사" variant="secondary">
          <Copy aria-hidden="true" />
        </IconButton>
        <IconButton label="설정" size="sm">
          <Settings aria-hidden="true" />
        </IconButton>
        <IconButton label="알림" size="sm" variant="secondary">
          <Bell aria-hidden="true" />
        </IconButton>
        <IconButton label="삭제 권한 없음" disabled>
          <Trash2 aria-hidden="true" />
        </IconButton>
        <a href="#buttons-h" className={buttonClass("link", "sm", "px-0")}>
          링크형(legacy)
        </a>
      </Row>
    </div>
  );
}

function Labels() {
  return (
    <div>
      <Row label="badge">
        <Badge>초안</Badge>
        <Badge tone="success">게시됨</Badge>
        <Badge tone="warning">검토 중</Badge>
        <Badge tone="danger">거절</Badge>
        <Badge tone="info">통제</Badge>
        <Badge tone="accent">AI-ready</Badge>
      </Row>
      <Row label="dot / status">
        <Badge dot tone="success">
          활성
        </Badge>
        <Badge dot tone="warning">
          만료 7일 전
        </Badge>
        <Badge dot>보관</Badge>
        <StatusBadge tone="success" label="승인" />
        <StatusBadge tone="danger" label="반려" />
      </Row>
      <Row label="tag">
        <Tag>이차전지</Tag>
        <Tag>전기화학 임피던스</Tag>
        <Tag onRemove={() => {}} removeLabel="용량 감소 제거">
          용량 감소
        </Tag>
      </Row>
      <Row label="avatar">
        {([[20, "김연구"], [24, "이데이터"], [32, "박관리"], [32, "Bora Steward"]] as const).map(([size, name]) => (
          <span key={name} className="inline-flex items-center gap-1.5">
            <Avatar name={name} size={size} />
            <span className="num text-caption text-fg-muted">{size}</span>
          </span>
        ))}
      </Row>
      <Row label="kbd">
        <span className="inline-flex items-center gap-1 text-small text-fg-muted">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd> 명령 팔레트
        </span>
        <span className="inline-flex items-center gap-1 text-small text-fg-muted">
          <Kbd>/</Kbd> 검색
        </span>
      </Row>
    </div>
  );
}

function Forms({ theme }: { theme: string }) {
  const [org, setOrg] = useState<(typeof ORGS)[number] | null>(ORGS[0]!);
  const [view, setView] = useState("detail");
  const [unit, setUnit] = useState<string | null>("week");
  const id = (s: string) => `${theme}-${s}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField id={id("title")} label="제목" required requiredLabel="(필수)">
        {(a) => <Input {...a} defaultValue="리튬이온 셀 사이클 측정" />}
      </FormField>
      <FormField id={id("doi")} label="DOI" hint="10.으로 시작하는 식별자">
        {(a) => <Input {...a} placeholder="10.1234/abcd" />}
      </FormField>
      <FormField id={id("end")} label="종료일" error="종료일은 시작일 이후여야 합니다">
        {(a) => <Input {...a} defaultValue="2025-01-31" />}
      </FormField>
      <FormField id={id("org")} label="소유 기관">
        {(a) => <Input {...a} value="한국전기연구원" disabled readOnly />}
      </FormField>
      <FormField id={id("purpose")} label="이용 목적 (native)">
        {(a) => (
          <Select {...a} defaultValue="research">
            <option value="research">비영리 연구</option>
            <option value="education">교육</option>
          </Select>
        )}
      </FormField>
      <FormField id={id("unit")} label="집계 단위 (SelectMenu)">
        {(a) => (
          <SelectMenu
            {...a}
            value={unit}
            onValueChange={setUnit}
            options={[
              { value: "day", label: "일" },
              { value: "week", label: "주" },
              { value: "month", label: "월" },
            ]}
          />
        )}
      </FormField>
      <FormField id={id("pick")} label="공동 기관 (Combobox)" className="sm:col-span-2">
        {(a) => (
          <Combobox
            {...a}
            items={ORGS}
            value={org}
            onValueChange={setOrg}
            itemToString={(o) => o.name}
            itemKey={(o) => o.id}
            renderItem={(o) => (
              <span className="flex items-center gap-2">
                <span>{o.name}</span>
                <span className="truncate text-small text-fg-muted">{o.unit}</span>
              </span>
            )}
            emptyText="일치하는 기관이 없습니다"
            openLabel="기관 목록 열기"
            placeholder="기관 검색"
          />
        )}
      </FormField>
      <FormField id={id("about")} label="설명" className="sm:col-span-2">
        {(a) => <Textarea {...a} rows={3} defaultValue="18650 셀 12종을 25°C에서 1C 충방전으로 200 사이클 측정한 원시 전압·전류·온도." />}
      </FormField>
      <div className="flex flex-col gap-2">
        <span className="text-small font-medium text-fg">선택</span>
        <label className="inline-flex items-center gap-2 text-body">
          <Checkbox defaultChecked /> 원시 데이터 포함
        </label>
        <label className="inline-flex items-center gap-2 text-body">
          <Checkbox /> 처리 데이터 포함
        </label>
        <label className="inline-flex items-center gap-2 text-body text-fg-subtle">
          <Checkbox disabled /> 문서 (없음)
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <span id={id("level")} className="text-small font-medium text-fg">
          공개 수준
        </span>
        <RadioGroup aria-labelledby={id("level")} defaultValue="controlled">
          <Radio value="public" label="공개" />
          <Radio value="controlled" label="통제" />
          <Radio value="private" label="비공개" disabled />
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-3">
        <Switch label="AI-ready만 보기" defaultChecked />
        <Switch label="알림 받기" />
      </div>
      <div className="flex flex-col items-start gap-3">
        <SegmentedControl
          aria-label="보기 방식"
          value={view}
          onValueChange={setView}
          items={[
            { value: "detail", label: "Detail", icon: <LayoutList aria-hidden="true" /> },
            { value: "compact", label: "Compact", icon: <Rows3 aria-hidden="true" /> },
            { value: "column", label: "Column", icon: <Columns3 aria-hidden="true" /> },
          ]}
        />
        <SegmentedControl
          aria-label="기간"
          value="30d"
          onValueChange={() => {}}
          items={[
            { value: "7d", label: "7일" },
            { value: "30d", label: "30일" },
            { value: "1y", label: "1년" },
          ]}
        />
      </div>
    </div>
  );
}

function Navigation() {
  return (
    <Tabs defaultValue="card">
      <TabsList aria-label="데이터셋 탭">
        <TabsTrigger value="card">데이터 카드</TabsTrigger>
        <TabsTrigger value="versions" count={4}>
          버전
        </TabsTrigger>
        <TabsTrigger value="lineage">계보</TabsTrigger>
        <TabsTrigger value="code" disabled>
          코드
        </TabsTrigger>
      </TabsList>
      <TabsContent value="card" className="text-body text-fg-muted">
        About, Data Explorer, 열 설명, 메타데이터.
      </TabsContent>
      <TabsContent value="versions" className="text-body text-fg-muted">
        v1.3.0 · 2026-09-21 · 박관리
      </TabsContent>
      <TabsContent value="lineage" className="text-body text-fg-muted">
        원천 2 · 파생 1
      </TabsContent>
    </Tabs>
  );
}

function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div>
      <Row label="tooltip">
        <Tooltip content="버전 비교">
          <Button size="sm">마우스를 올리세요</Button>
        </Tooltip>
      </Row>
      <Row label="popover">
        <Popover>
          <PopoverTrigger className={buttonClass("secondary", "sm")}>
            <Bell aria-hidden="true" />
            알림
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <PopoverTitle>알림</PopoverTitle>
            <PopoverDescription>새 알림이 없습니다.</PopoverDescription>
          </PopoverContent>
        </Popover>
        <Menu.Root>
          <Menu.Trigger className={buttonClass("secondary", "sm")}>
            <MoreHorizontal aria-hidden="true" />
            작업
          </Menu.Trigger>
          <Menu.Content>
            <Menu.Group>
              <Menu.Label>데이터셋</Menu.Label>
              <Menu.Item icon={<Pencil aria-hidden="true" />} shortcut="E">
                편집
              </Menu.Item>
              <Menu.Item icon={<FolderOpen aria-hidden="true" />}>파일 열기</Menu.Item>
              <Menu.Item icon={<FileText aria-hidden="true" />} disabled>
                DOI 발급 (준비 중)
              </Menu.Item>
            </Menu.Group>
            <Menu.Separator />
            <Menu.Item tone="danger" icon={<Trash2 aria-hidden="true" />}>
              보관
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </Row>
      <Row label="dialog">
        <Button size="sm" onClick={() => setDialog(true)}>
          대화상자
        </Button>
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
          확인 대화상자
        </Button>
        <Sheet>
          <SheetTrigger className={buttonClass("secondary", "sm")}>시트</SheetTrigger>
          <SheetContent closeLabel="닫기">
            <SheetHeader>
              <SheetTitle>파일 정보</SheetTitle>
              <SheetDescription>processed/capacity_fade.parquet</SheetDescription>
            </SheetHeader>
            <SheetBody className="text-body text-fg-muted">48,200행 · 6.1 MB</SheetBody>
          </SheetContent>
        </Sheet>
      </Row>
      <Row label="toast">
        <Button size="sm" onClick={() => notify.success("버전 v1.3.0을 발행했습니다", { description: "구독자 12명에게 알렸습니다." })}>
          성공
        </Button>
        <Button size="sm" onClick={() => notify.error("업로드에 실패했습니다", { description: "네트워크 연결을 확인하세요." })}>
          오류
        </Button>
        <Button
          size="sm"
          onClick={() =>
            notify.promise(new Promise((r) => setTimeout(r, 1500)), { loading: "파일 검증 중…", success: "4개 파일을 검증했습니다", error: "검증 실패" })
          }
        >
          진행
        </Button>
      </Row>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent closeLabel="닫기">
          <DialogTitle>새 버전 만들기</DialogTitle>
          <DialogDescription>현재 초안의 파일을 그대로 가져옵니다.</DialogDescription>
          <div className="mt-4">
            <FormField id="dlg-label" label="버전 라벨">
              {(a) => <Input {...a} defaultValue="v1.4.0" />}
            </FormField>
          </div>
          <DialogFooter>
            <Button onClick={() => setDialog(false)}>취소</Button>
            <Button variant="primary" onClick={() => setDialog(false)}>
              만들기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="프로젝트를 보관할까요?"
        description="보관하면 모든 데이터 접근 권한이 즉시 회수됩니다."
        confirmLabel="보관"
        cancelLabel="취소"
        closeLabel="닫기"
        destructive
        onConfirm={() => setConfirm(false)}
      />
    </div>
  );
}

function CommandPreview() {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <CommandMenu.Root label="명령 팔레트 미리보기">
        <CommandMenu.Input placeholder="데이터셋, 프로젝트, 명령 검색" />
        <CommandMenu.List>
          <CommandMenu.Empty>결과가 없습니다</CommandMenu.Empty>
          <CommandMenu.Group heading="이동">
            <CommandMenu.Item icon={<Database aria-hidden="true" />} shortcut="G D">
              데이터
            </CommandMenu.Item>
            <CommandMenu.Item icon={<FolderOpen aria-hidden="true" />} shortcut="G P">
              프로젝트
            </CommandMenu.Item>
          </CommandMenu.Group>
          <CommandMenu.Group heading="행동">
            <CommandMenu.Item icon={<Plus aria-hidden="true" />}>새 데이터셋</CommandMenu.Item>
            <CommandMenu.Item icon={<Settings aria-hidden="true" />}>테마 전환</CommandMenu.Item>
          </CommandMenu.Group>
        </CommandMenu.List>
      </CommandMenu.Root>
    </div>
  );
}

function DataDisplay() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="내 프로젝트" value="7" />
        <Stat label="검토 대기" value="3" delta="+2" trend="up" hint="어제보다" />
        <Stat label="활성 권한" value="18" />
        <Stat label="곧 만료" value="2" delta="−1" trend="down" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-mono text-fg">voltage_v</span>
            <span className="font-mono text-caption text-fg-muted">float64</span>
          </div>
          <MiniHistogram label="voltage_v 분포" bins={VOLTAGE} labels={VOLTAGE.map((_, i) => `${(2.5 + i * 0.1).toFixed(1)} V`)} highlight={[6, 7]} />
          <div className="num mt-2 flex justify-between font-mono text-caption text-fg-muted">
            <span>2.50</span>
            <span>4.20</span>
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-mono text-fg">temp_c</span>
            <span className="font-mono text-caption text-fg-muted">float32</span>
          </div>
          <MiniHistogram label="temp_c 분포" bins={TEMP} />
          <div className="num mt-2 flex justify-between font-mono text-caption text-fg-muted">
            <span>18.2</span>
            <span>41.7</span>
          </div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          { label: "업로드", value: 62, text: "62% · 3 / 5 파일", tone: "accent" as const },
          { label: "검증", value: 100, text: "완료 · 5 / 5", tone: "success" as const },
        ].map((p) => (
          <div key={p.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-small">
              <span className="text-fg">{p.label}</span>
              <span className="num text-fg-muted">{p.text}</span>
            </div>
            <Progress label={`${p.label} 진행률`} value={p.value} valueText={p.text} tone={p.tone} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <PathText value="raw/2026/cycling/cell-0042/session-17/voltage_current_temperature.parquet" copyLabel="경로 복사" copiedLabel="복사했습니다" />
        <PathText value="sha256:9f2c4e1a7b3d5f6e8a0c2b4d6f8e1a3c5e7b9d0f2a4c6e8b0d2f4a6c8e0b2d4f" copyLabel="해시 복사" copiedLabel="복사했습니다" />
      </div>
      <DataTable caption="버전 v1.3.0 파일" columns={COLUMNS.filter((c) => c.key !== "rows")} rows={FILES} rowKey={(r) => r.id} selectedKey="2" />
      <DataTable caption="파일 (dense)" columns={COLUMNS.slice(0, 4)} rows={FILES.slice(0, 2)} rowKey={(r) => r.id} dense />
    </div>
  );
}

function States() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2" role="status" aria-label="불러오는 중">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <div className="rounded-md border border-border">
        <EmptyState
          icon={Database}
          title="아직 데이터셋이 없습니다"
          description="첫 데이터셋을 등록하면 이곳에 표시됩니다."
          action={
            <Button variant="primary" size="sm">
              <Plus aria-hidden="true" />새 데이터셋
            </Button>
          }
        />
      </div>
      <ErrorState
        title="데이터를 불러오지 못했습니다"
        message="찾을 수 없거나 접근 권한이 없습니다."
        traceId="4f1c9a2e7d3b"
        traceIdLabel="추적 ID"
        copyLabel="복사"
        copiedLabel="복사됨"
        copyFailedLabel="복사 실패"
        retryLabel="다시 시도"
        onRetry={() => {}}
      />
    </div>
  );
}

export function UiGallery() {
  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <header className="mb-8">
        <h1 className="text-display text-fg">UI 부품</h1>
        <p className="mt-1 text-body text-fg-muted">@nais/ui 부품의 변형과 상태. 같은 견본을 라이트와 다크 테마로 각각 고정해 나란히 그립니다.</p>
      </header>
      <Section id="buttons" title="버튼" note="primary · secondary · ghost · danger, 28 / 32 / 40px">
        {() => <Buttons />}
      </Section>
      <Section id="labels" title="라벨" note="Badge, StatusBadge, Tag, Avatar, Kbd">
        {() => <Labels />}
      </Section>
      <Section id="forms" title="입력" note="32px 필드, 오류는 aria-describedby로 연결">
        {(theme) => <Forms theme={theme} />}
      </Section>
      <Section id="nav" title="탭" note="밑줄형, 전환 애니메이션 없음">
        {() => <Navigation />}
      </Section>
      <Section id="overlays" title="떠 있는 레이어" note="팝오버·메뉴·대화상자는 페이지 테마로 열립니다">
        {() => <Overlays />}
      </Section>
      <Section id="command" title="명령 팔레트" note="cmdk, 열고 닫을 때 애니메이션 없음">
        {() => <CommandPreview />}
      </Section>
      <Section id="data" title="데이터" note="Stat, MiniHistogram, Progress, PathText, DataTable">
        {() => <DataDisplay />}
      </Section>
      <Section id="states" title="상태" note="Skeleton, EmptyState, ErrorState">
        {() => <States />}
      </Section>
    </div>
  );
}
