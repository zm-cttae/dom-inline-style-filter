const benchIframe = document.createElement('iframe');
benchIframe.id = 'test-bench';

benchIframe.style.height = '100vh';
benchIframe.style.width = '100vw';
benchIframe.style.margin = '0';
benchIframe.style.padding = '0';
benchIframe.style.position = 'fixed';

document.body.style.margin = '0';
document.body.style.padding = '0';

document.body.appendChild(benchIframe);