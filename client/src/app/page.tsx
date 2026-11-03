import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { Hero } from '@/features/landing/hero';
import { Benefits } from '@/features/landing/benefits';
import { HowItWorks } from '@/features/landing/how-it-works';
import { Networks } from '@/features/landing/networks';
import { Questions } from '@/features/landing/questions';
import { Closing } from '@/features/landing/closing';
import { networks } from '@/lib/networks';

export default function Home() {
  return (
    <>
      <Navbar />
      <main id="main">
        <Hero />
        <Benefits />
        <HowItWorks />
        <Networks networks={networks} />
        <Questions />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
