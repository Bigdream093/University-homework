import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQDfWDIwacHAClqwihzfiS1QAAAABJRU5ErkJggg==",
  "base64",
);
async function actor(request, username = "teacher") {
  const result = await request.post("/api/auth/login", {
    data: { username, password: "123456" },
  });
  expect(result.ok()).toBeTruthy();
  return result.json();
}
async function session(page, user, url) {
  await page.goto("/login");
  await page.evaluate((user) => {
    localStorage.setItem("hw_token", user.token);
    localStorage.setItem(
      "hw_user",
      JSON.stringify({ ...user.user, must_change_password: 0 }),
    );
  }, user);
  await page.goto(url);
}

test("Rich-text assignment: PPT paste, drop, merged cells, resized columns and saved images", async ({
  page,
  request,
}, testInfo) => {
  const teacher = await actor(request);
  const headers = { Authorization: `Bearer ${teacher.token}` };
  const course = await (
    await request.post("/api/courses", {
      headers,
      data: { name: "图文编辑验收" },
    })
  ).json();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await session(page, teacher, `/teacher/courses/${course.id}`);
  await page.getByRole("button", { name: "发布新作业", exact: true }).click();
  const form = page.getByRole("dialog", { name: "创建作业", exact: true });
  await form.getByLabel("作业标题", { exact: true }).fill("截图与表格作业");
  const editor = form.getByRole("textbox", {
    name: "作业要求富文本",
    exact: true,
  });
  await editor.fill("作业目标：请提交三张分析图");
  await form.getByRole("button", { name: "插入表格", exact: true }).click();
  await expect(editor.locator("table")).toBeVisible();
  const cells = editor.locator("td,th");
  await cells.nth(0).click();
  await cells.nth(1).click({ modifiers: ["Shift"] });
  await form.getByRole("button", { name: "合并单元格", exact: true }).click();
  await expect(editor.locator("th[colspan='2'],td[colspan='2']")).toHaveCount(1);
  const resizeCell = editor.locator("tr").nth(1).locator("td").first();
  const resizeCellBox = await resizeCell.boundingBox();
  await page.mouse.move(resizeCellBox.x + resizeCellBox.width - 1, resizeCellBox.y + 10);
  const handle = editor.locator(".column-resize-handle").first();
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 1, handleBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 45, handleBox.y + 10);
  await page.mouse.up();
  await form
    .locator("input[type=file]")
    .setInputFiles({ name: "选择.png", mimeType: "image/png", buffer: png });
  await expect(
    form.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await expect(form.locator(".rich-image img")).toHaveCount(1);
  for (const eventType of ["paste", "drop"]) {
    await editor.evaluate(
      (element, { eventType, bytes }) => {
        const file = new File([new Uint8Array(bytes)], eventType + ".png", { type: "image/png" });
        let event;
        if (eventType === "paste") {
          event = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "clipboardData", { value: {
            files: [],
            items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
            getData: () => "",
          }});
        } else {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          event = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 100, clientY: 200 });
        }
        element.dispatchEvent(event);
      },
      { eventType, bytes: [...png] },
    );
    await expect(
      form.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await expect(form.locator(".rich-image img")).toHaveCount(
      eventType === "paste" ? 2 : 3,
    );
  }
  await expect
    .poll(() =>
      form
        .locator(".rich-image img")
        .evaluateAll((images) =>
          images.every((img) => img.complete && img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await form.getByRole("button", { name: "全屏编辑", exact: true }).click();
  await expect(form.locator(".rich-text-editor")).toHaveClass(/fullscreen/);
  await form.getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("markdown-assignment.png"),
    fullPage: true,
  });
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(form).not.toBeVisible();
  const assignments = await (
    await request.get(`/api/courses/${course.id}/assignments`, { headers })
  ).json();
  expect(assignments[0].description_format).toBe("html");
  expect(assignments[0].description.match(/<img\b/g)).toHaveLength(3);
  expect(assignments[0].description).toContain('colspan="2"');
  expect(assignments[0].description).toMatch(/colwidth="[0-9,]+"/);
  await page
    .getByRole("heading", { name: "截图与表格作业", exact: true })
    .click();
  await expect(
    page.locator(".card-body .rich-text-content table"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".card-body .rich-text-content img")
        .evaluateAll(
          (images) =>
            images.length === 3 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑作业", exact: true });
  await expect(
    edit.getByRole("textbox", { name: "作业要求富文本", exact: true }),
  ).toContainText("作业目标");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      edit.locator(".editor-frame").evaluate((element) => element.scrollWidth >= element.clientWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("markdown-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Notice and student Q&A use the shared editor and retain screenshots after saving", async ({
  page,
  request,
}) => {
  const teacher = await actor(request);
  const headers = { Authorization: `Bearer ${teacher.token}` };
  const course = await (
    await request.post("/api/courses", {
      headers,
      data: { name: "通知问答图文验收" },
    })
  ).json();
  const studentName = "20269888";
  await request.post(`/api/courses/${course.id}/students`, {
    headers,
    data: { username: studentName, name: "截图同学" },
  });
  await session(page, teacher, `/teacher/courses/${course.id}`);
  await page.getByRole("tab", { name: /^通知/ }).click();
  await page.getByRole("button", { name: "发布通知", exact: true }).click();
  const notice = page.getByRole("dialog", { name: "发布通知", exact: true });
  await notice.getByLabel("标题", { exact: true }).fill("图文通知");
  await notice
    .getByRole("textbox", { name: "通知内容富文本", exact: true })
    .fill("通知正文");
  await notice
    .locator("input[type=file]")
    .setInputFiles({ name: "通知.png", mimeType: "image/png", buffer: png });
  await expect(notice.locator(".rich-image img")).toHaveCount(1);
  await notice.getByText("立即发布", { exact: true }).click();
  await notice.getByRole("button", { name: "保存", exact: true }).click();
  await expect(notice).not.toBeVisible();
  const student = await actor(request, studentName);
  await session(page, student, `/student/courses/${course.id}`);
  await page.getByRole("tab", { name: /^通知/ }).click();
  await page.getByRole("heading", { name: "图文通知", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".rich-text-content img")
        .evaluateAll(
          (images) =>
            images.length > 0 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await page.getByRole("tab", { name: "课程问答", exact: true }).click();
  await page.getByRole("button", { name: "提问", exact: true }).click();
  const question = page.getByRole("dialog", { name: "提出问题", exact: true });
  await question.getByPlaceholder("标题", { exact: true }).fill("请看截图");
  await question
    .getByRole("textbox", { name: "问题内容富文本", exact: true })
    .fill("这个步骤如何处理？");
  await question
    .locator("input[type=file]")
    .setInputFiles({ name: "疑问.png", mimeType: "image/png", buffer: png });
  await expect(question.locator(".rich-image img")).toHaveCount(1);
  await question.getByRole("button", { name: "保存", exact: true }).click();
  await expect(question).not.toBeVisible();
  await page.getByRole("button", { name: "请看截图", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "请看截图", exact: true });
  await expect
    .poll(() =>
      detail
        .locator(".rich-text-content img")
        .evaluateAll(
          (images) =>
            images.length > 0 && images.every((img) => img.naturalWidth > 0),
        ),
    )
    .toBe(true);
  await detail
    .getByRole("textbox", { name: "私人回复富文本", exact: true })
    .fill("补充说明");
  await detail
    .getByRole("button", { name: "发送私人回复", exact: true })
    .click();
  await expect(detail.locator(".rich-text-content").filter({ hasText: "补充说明" })).toBeVisible();
});
