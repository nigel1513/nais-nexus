import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, PROJECT, THREAD, USER } from "@/mocks/fixtures";
import { renderScreen } from "../../../tests/render";
import { DatasetDetailScreen } from "./dataset-detail-screen";

configure({ asyncUtilTimeout: 5000 });

const open = (dataset: string, user: string, query = "") => renderScreen(<DatasetDetailScreen datasetId={dataset} />, { user, path: `/commons/data/${dataset}${query}` });

describe("Data Card: 프로젝트 · 토론 · 이력", () => {
  it("adds the three sections to the section nav", async () => {
    open(DATASET.battery, USER.aResearcher);
    const nav = await screen.findByRole("navigation", { name: "데이터 카드 섹션" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["개요", "파일·분포", "스키마", "메타데이터", "프로젝트", "토론", "이력"]);
    for (const l of links) expect(document.getElementById(l.getAttribute("href")!.slice(1))).not.toBeNull();
    await userEvent.click(links[5]!);
    expect(document.getElementById("card-discussion")).toHaveFocus();
  });

  it("lists the projects I am in; the rest are only counted", async () => {
    const { unmount } = open(DATASET.battery, USER.aResearcher);
    const section = await screen.findByRole("region", { name: "이 데이터를 쓴 프로젝트" });
    const link = await within(section).findByRole("link", { name: "차세대 이차전지 소재 공동연구" });
    expect(link).toHaveAttribute("href", `/commons/projects/${PROJECT.seed}`);
    unmount();
    open(DATASET.battery, USER.bSteward);
    const other = await screen.findByRole("region", { name: "이 데이터를 쓴 프로젝트" });
    expect(await within(other).findByText("참여하지 않은 프로젝트 1곳에서도 사용 중입니다.")).toBeInTheDocument();
  });

  it("shows the dataset threads, opens one and replies", async () => {
    open(DATASET.battery, USER.aResearcher);
    const section = await screen.findByRole("region", { name: "토론" });
    await userEvent.click(await within(section).findByRole("button", { name: /temp_c 주기적 상승 구간 확인 요청/ }));
    const thread = await within(section).findByRole("article", { name: "temp_c 주기적 상승 구간 확인 요청" });
    expect(await within(thread).findByText(/9 사이클마다 26 ℃를 넘습니다/)).toBeInTheDocument();
    await userEvent.type(within(thread).getByRole("textbox", { name: "답글" }), "챔버 로그를 확인해 보겠습니다.");
    await userEvent.click(within(thread).getByRole("button", { name: "답글 달기" }));
    expect(await within(thread).findByText("챔버 로그를 확인해 보겠습니다.")).toBeInTheDocument();
    expect(getDb().comments.filter((c) => c.thread_id === THREAD.dataset)).toHaveLength(2);
    await userEvent.click(within(section).getByRole("button", { name: "토론 목록" }));
    expect(await within(section).findByRole("button", { name: /temp_c 주기적 상승 구간 확인 요청/ })).toBeInTheDocument();
  });

  it("starts a new thread", async () => {
    open(DATASET.battery, USER.bResearcher);
    const section = await screen.findByRole("region", { name: "토론" });
    await userEvent.click(await within(section).findByRole("button", { name: "새 토론" }));
    await userEvent.type(within(section).getByRole("textbox", { name: "제목" }), "셀 정보 파일 열 설명 요청");
    await userEvent.type(within(section).getByRole("textbox", { name: "내용" }), "cell_info.csv의 `lot` 열 의미를 알려 주세요.");
    await userEvent.click(within(section).getByRole("button", { name: "토론 시작" }));
    expect(await within(section).findByRole("article", { name: "셀 정보 파일 열 설명 요청" })).toBeInTheDocument();
    expect(getDb().threads.some((t) => t.title === "셀 정보 파일 열 설명 요청" && t.target_id === DATASET.battery)).toBe(true);
  });

  it("?tab=discussion (notification link) lands on the 토론 section", async () => {
    open(DATASET.battery, USER.bSteward, "?tab=discussion");
    await waitFor(() => expect(document.getElementById("card-discussion")).toHaveFocus());
  });

  it("shows the dataset history", async () => {
    open(DATASET.battery, USER.aResearcher);
    const section = await screen.findByRole("region", { name: "이력" });
    expect((await within(section).findAllByText("버전 게시")).length).toBeGreaterThan(0);
    expect(within(section).getAllByText("토론 시작").length).toBeGreaterThan(0);
    expect(within(section).getAllByRole("link", { name: "차세대 이차전지 소재 공동연구" })[0]).toHaveAttribute("href", `/commons/projects/${PROJECT.seed}`);
  });
});

describe("Data Card: 프로젝트에서 열기", () => {
  it("adds the dataset as an input of a project I can write to", async () => {
    open(DATASET.qcLogs, USER.bResearcher);
    const header = (await screen.findByRole("heading", { level: 1, name: "소결 공정 배치별 품질관리 로그" })).closest("section")!;
    await userEvent.click(within(header).getByRole("button", { name: "프로젝트에서 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "프로젝트에서 열기" });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /차세대 이차전지 소재 공동연구/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "입력으로 추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "프로젝트에서 열기" })).toBeNull());
    expect(getDb().inputs.some((i) => i.dataset_id === DATASET.qcLogs && i.project_id === PROJECT.seed && !i.removed_at)).toBe(true);
    const section = screen.getByRole("region", { name: "이 데이터를 쓴 프로젝트" });
    expect(await within(section).findByRole("link", { name: "차세대 이차전지 소재 공동연구" })).toBeInTheDocument();
  });

  it("marks projects that already use the dataset", async () => {
    open(DATASET.battery, USER.aResearcher);
    const header = (await screen.findByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).closest("section")!;
    await userEvent.click(within(header).getByRole("button", { name: "프로젝트에서 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "프로젝트에서 열기" });
    const radio = await within(dialog).findByRole("radio", { name: /차세대 이차전지 소재 공동연구/ });
    expect(radio).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText("이미 입력으로 사용 중")).toBeInTheDocument();
  });

  it("without an access grant, leads to the access request", async () => {
    open(DATASET.sensors, USER.bResearcher);
    const header = (await screen.findByRole("heading", { level: 1, name: "시험동 공조 설비 센서 스트림" })).closest("section")!;
    await userEvent.click(within(header).getByRole("button", { name: "프로젝트에서 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "프로젝트에서 열기" });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /차세대 이차전지 소재 공동연구/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "입력으로 추가" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("접근 권한이 필요합니다");
    await userEvent.click(within(alert).getByRole("button", { name: "접근 요청" }));
    expect(await screen.findByRole("dialog", { name: "접근 요청" })).toBeInTheDocument();
    expect(getDb().inputs.some((i) => i.dataset_id === DATASET.sensors)).toBe(false);
  });
});
