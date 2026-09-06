import type { Metadata } from "next";
import SunflowerGame from "./game";

export const metadata: Metadata = {
  title: "画里有风 · 向日葵之外",
  description: "走进梵高《向日葵》延伸出的金色世界，自由漫游、发现风景，用相机留下光的切片。",
};

export default function SunflowersPage() {
  return <SunflowerGame />;
}
