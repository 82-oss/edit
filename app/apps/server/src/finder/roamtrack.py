# roamtrack.py <tag> <media>: follows each wandering mark frame by frame: its look learned from the clear sightings, then
# matched around where it should be -> <media>.roam.masks.json  [first frame, last frame, box, 'mark']
import sys,json,cv2,numpy as np,difflib
tag,mid=sys.argv[1],sys.argv[2]; sys.argv=sys.argv[:3]
import scan
STEP=3
def grad(g):
    g=cv2.GaussianBlur(g,(0,0),1.2); gx=cv2.Sobel(g,cv2.CV_32F,1,0); gy=cv2.Sobel(g,cv2.CV_32F,0,1); return cv2.magnitude(gx,gy)
def merge(ms):
    # fragments of one mark ("bodyc", "mtube" of "bodycamtubes") are that mark
    ms=sorted([m for m in ms if m['kind']=='roamer' or m['kind']=='label'],key=lambda m:-m['n']); out=[]
    for m in ms:
        for o in out:
            if o['kind']=='roamer' and (m['key'] in o['key'] or difflib.SequenceMatcher(None,m['key'],o['key']).ratio()>0.55): break
        else:
            if m['kind']=='roamer': out.append(m)
    return out
def main():
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); W,H,fps=Z['W'],Z['H'],Z['fps']
    marks=merge(json.load(open(f'{tag}/scan/{mid}.marks.json'))); allm=[]
    cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4')
    def frame(f):
        cap.set(cv2.CAP_PROP_POS_FRAMES,f); ok,img=cap.read(); return cv2.cvtColor(img,cv2.COLOR_BGR2GRAY) if ok else None
    for m in marks:
        full=[r for r in m['reads'] if abs((r[3]-r[1])-m['w'])<0.08*m['w']]
        if len(full)<15: print(mid,m['key'],'too few clear sightings',len(full)); continue
        pts={r[0]:((r[1]+r[3])/2,(r[2]+r[4])/2) for r in full}
        # its look: the clear sightings laid over one another, edges only; what's the scene's averages away
        w,h=m['w'],m['h']; rx,ry0,ry1=int(0.75*w),int(3.2*h),int(2.2*h)
        pick=full[::max(1,len(full)//80)]; acc=None; n=0
        for r in pick:
            g=frame(r[0]); cx,cy=int((r[1]+r[3])/2),int((r[2]+r[4])/2)
            if g is None: continue
            P=max(rx,ry0,ry1); g=cv2.copyMakeBorder(g,P,P,P,P,cv2.BORDER_REFLECT); cx+=P; cy+=P
            e=grad(g[cy-ry0:cy+ry1,cx-rx:cx+rx]); e/=e.mean()+1e-6
            if acc is not None and n>=10:
                # laid where it fits what's been learned so far (the reader's box is a few pixels off each time)
                big=grad(g[cy-ry0-12:cy+ry1+12,cx-rx-12:cx+rx+12]); rr=cv2.matchTemplate(big,(acc/n).astype(np.float32),cv2.TM_CCOEFF_NORMED); _,_,_,l=cv2.minMaxLoc(rr)
                e=big[l[1]:l[1]+e.shape[0],l[0]:l[0]+e.shape[1]]; e=e/(e.mean()+1e-6)
            acc=e if acc is None else acc+e; n+=1
        if n<8: print(mid,m['key'],'no room to learn its look'); continue
        tpl=acc/n; base=np.median(tpl); k=tpl>base+2.5*(np.percentile(tpl,75)-base)
        k=cv2.morphologyEx(k.astype(np.uint8),cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
        ys,xs=np.where(cv2.dilate(k,np.ones((9,9),np.uint8))>0)
        # the mark's reach about its words' centre
        ext=[int(xs.min()-rx),int(ys.min()-ry0),int(xs.max()-rx),int(ys.max()-ry0)]
        ext=[min(ext[0],-int(w/2)),min(ext[1],-int(h/2)),max(ext[2],int(w/2)),max(ext[3],int(h/2))]
        json.dump(ext,open(f'{tag}/scan/{mid}.roam.ext.json','w'))
        t=tpl[ry0+ext[1]:ry0+ext[3],rx+ext[0]:rx+ext[2]].astype(np.float32)
        cv2.imwrite(f'{tag}/look/{mid}.{m["key"][:12]}.tpl.png',np.clip(tpl/tpl.max()*255*2,0,255).astype(np.uint8))
        # every 3rd frame: the best fit anywhere in the picture (at half size), then exactly, at full size, around it
        th=cv2.resize(t,(t.shape[1]//2,t.shape[0]//2),interpolation=cv2.INTER_AREA); track={}; scores=[]; raw={}
        for a,b in scan.chunks():
            f0=int(a*fps); f1=int(b*fps); f0-=f0%STEP
            cap.set(cv2.CAP_PROP_POS_FRAMES,f0); f=f0
            while f<=f1:
                ok,img=cap.read()
                if not ok: break
                g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY); e=grad(cv2.resize(g,(W//2,H//2),interpolation=cv2.INTER_AREA))
                r=cv2.matchTemplate(e,th,cv2.TM_CCOEFF_NORMED); _,sc,_,loc=cv2.minMaxLoc(r)
                X0=max(0,loc[0]*2-8); Y0=max(0,loc[1]*2-8); X1=min(W,X0+t.shape[1]+16); Y1=min(H,Y0+t.shape[0]+16)
                r2=cv2.matchTemplate(grad(g[Y0:Y1,X0:X1]),t,cv2.TM_CCOEFF_NORMED); _,sc2,_,l2=cv2.minMaxLoc(r2)
                raw[f]=(X0+l2[0]-ext[0],Y0+l2[1]-ext[1],float(sc2)); scores.append(sc2)
                for _ in range(STEP-1):
                    if not cap.grab(): break
                f+=STEP
        # a fit is believed when it agrees with its neighbours (the mark glides or sits; a chance fit jumps about)
        ks=sorted(raw); P=np.array([raw[k][:2] for k in ks]); S=np.array([raw[k][2] for k in ks]); good=np.zeros(len(ks),bool)
        for i in range(len(ks)):
            js=[j for j in range(max(0,i-4),min(len(ks),i+5)) if j!=i and abs(ks[j]-ks[i])<=4*STEP]
            agree=sum(np.hypot(*(P[j]-P[i]))<=6+2.0*abs(ks[j]-ks[i]) for j in js)
            good[i]=S[i]>=0.2 and agree>=max(2,0.5*len(js))
        gi=np.where(good)[0]
        for i,k in enumerate(ks):
            if good[i]: track[k]=(P[i][0],P[i][1],S[i]); continue
            # not made out here: between where it was before and after (it glides), if those are near in time
            q=np.searchsorted(gi,i); pa=gi[q-1] if q>0 else None; pb=gi[q] if q<len(gi) else None
            if pa is not None and pb is not None and ks[pb]-ks[pa]<=30*30 and ks[pb]-ks[pa]==(pb-pa)*STEP:
                u=(k-ks[pa])/(ks[pb]-ks[pa]); track[k]=(P[pa][0]+u*(P[pb][0]-P[pa][0]),P[pa][1]+u*(P[pb][1]-P[pa][1]),-1)
        json.dump({'ks':ks,'P':P.tolist(),'S':S.tolist(),'good':good.tolist()},open(f'{tag}/scan/{mid}.roam.raw.json','w'))
        found=sum(1 for v in track.values() if v[2]>=0)
        print(mid,m['key'],'look learned from',n,'sightings; reach',ext,'| steps',len(raw),'placed',len(track),'matched',found,f'({100*found/max(1,len(track)):.0f}%)','median match',round(float(np.median(scores)),2) if scores else None)
        ks=sorted(track); i=0
        while i<len(ks):
            j=i
            while j+1<len(ks) and ks[j+1]-ks[j]==STEP: j+=1
            # one blur box a step, covering where it is at both ends of the step
            for q in range(i,j+1):
                x,y,_=track[ks[q]]; x2,y2,_=track[ks[min(j,q+1)]]
                bx=[int(min(x,x2)+ext[0]-8),int(min(y,y2)+ext[1]-8),int(max(x,x2)+ext[2]+8),int(max(y,y2)+ext[3]+8)]
                allm.append([ks[q]-1 if q==i else ks[q],ks[q]+STEP-1,max(0,bx[0]),max(0,bx[1]),min(W,bx[2]),min(H,bx[3]),'mark'])
            i=j+1
    json.dump(allm,open(f'{tag}/scan/{mid}.roam.masks.json','w'))
main()
