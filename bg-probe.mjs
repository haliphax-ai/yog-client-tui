import { newStyle } from "@oakoliver/lipgloss";
const cases = {
  "bg only": newStyle().background("#3f3f46").foreground("#d4d4d8"),
  "bg + padding": newStyle().background("#3f3f46").foreground("#d4d4d8").padding(1),
  "bg + padding + width": newStyle().background("#3f3f46").foreground("#d4d4d8").padding(1).width(40),
  "bg + width": newStyle().background("#3f3f46").foreground("#d4d4d8").width(40),
};
for (const [name, s] of Object.entries(cases)) {
  const out = s.render("hello");
  const hasBg = /48;2;63;63;70|48;5;/.test(out);
  console.log(name.padEnd(22), "bg:", hasBg, JSON.stringify(out.slice(0, 90)));
}